// 双层心跳（传输保活 ≠ 会话续租）：
//   传输心跳：周期 Ping，探活死链——业务拒绝（往返完成）不计死链，网络类失败
//   连续 N 次判定死链并关闭当前代连接触发重连；按代绑定（换代时旧循环随代退出）。
//   会话心跳：仅业务通道（kind 门控）——周期调用业务 Heartbeat 续租会话；
//   业务错误经 CAS 单飞触发重登钩子，网络错误静默（重连机制处理）。
import { HeartbeatOperation, type Channel, type Generation } from './channel.js';
import { WithFailFast, WithRequestTimeout } from './options.js';
import { BusinessError } from './errors.js';

/** 传输保活心跳循环：绑定单代连接；死链只关闭本代（按代精确匹配，旧代心跳失败
 * 不误杀已换代的新连接）。心跳 Invoke 携带 failFast：死链期间排队无意义，心跳
 * 自身的失败计数就是重连触发器。 */
export async function transportHeartbeatLoop(ch: Channel, gen: Generation): Promise<void> {
  const interval = ch.settings.heartbeatIntervalMs;
  if (interval <= 0) return; // 显式关闭
  let failures = 0;
  for (;;) {
    if (!(await sleepInterruptible(interval, ch.onClosed, gen.done))) return;
    if (ch.closed || ch.currentGeneration() !== gen) return; // 已换代/已关闭
    try {
      await ch.invoke(HeartbeatOperation, null, WithFailFast(), WithRequestTimeout(Math.min(interval, 10_000)));
      failures = 0;
    } catch (err) {
      if (err instanceof BusinessError) {
        // 业务拒绝 = 请求-响应往返完成 = 链路存活，失败计数归零——服务端拒绝属
        // 配置/语义问题而非链路故障，重连无意义。
        failures = 0;
        continue;
      }
      // 网络类失败（超时/写失败）：无往返，计死链；连续 N 次 → 关闭本代触发重连。
      failures += 1;
      if (failures >= 3) {
        void gen.transport.close().catch(() => {});
        return;
      }
    }
  }
}

/** 会话心跳循环（仅业务通道；顶层配置不波及战斗通道）：业务错误单飞触发重登钩子。 */
export async function sessionHeartbeatLoop(ch: Channel): Promise<void> {
  const cfg = ch.settings.sessionHeartbeat;
  if (ch.kind !== 'business' || !cfg) return;
  for (;;) {
    if (!(await sleepInterruptible(cfg.intervalMs, ch.onClosed))) return;
    if (ch.closed) return;
    // 重连钩子执行期间（hookBypass）或上一轮触发的重登未返回时跳过本轮。
    if (ch.hookBypass || ch.sessionHookBusy) continue;
    let op: string;
    let req: unknown;
    try {
      const next = cfg.factory();
      if (!next) continue; // 工厂未就绪（如尚未登录）：跳过本轮
      op = next.op;
      req = next.req ?? null;
    } catch {
      continue; // 工厂异常：跳过本轮
    }
    try {
      await ch.invoke(op, req);
    } catch (err) {
      if (err instanceof BusinessError) {
        // 会话失效（业务拒绝）：单飞触发重登钩子（triggerReloginHook 内部再查
        // hookBypass/busy）；失败静默，下一轮会话心跳再触发。
        ch.triggerReloginHook();
      }
      // 网络类失败静默：重连机制处理。
    }
  }
}

/** 每代连接建立后启动的心跳编排：传输心跳随代启动（随代死亡退出）；
 * 会话心跳仅首次启动一次（内部循环跨代；评审缺陷：每代启动会随重连次数
 * 泄漏 N 个并发会话心跳循环）。由 supervisor 调用。 */
export function startChannelHeartbeats(ch: Channel, gen: Generation): void {
  void transportHeartbeatLoop(ch, gen);
  // supervise 单线程调用本函数，无并发竞态：boolean 检查+置位即可。
  if (!ch.sessionLoopStarted) {
    ch.sessionLoopStarted = true;
    void sessionHeartbeatLoop(ch);
  }
}

/** 可被关闭信号或代死亡打断的睡眠。 */
async function sleepInterruptible(ms: number, closed: Promise<void>, genDone?: Promise<void>): Promise<boolean> {
  if (ms <= 0) return true;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  try {
    const signals: Promise<boolean>[] = [
      new Promise<boolean>((resolve) => {
        timers.push(setTimeout(() => resolve(true), ms));
      }),
      closed.then(() => false),
    ];
    if (genDone) signals.push(genDone.then(() => false));
    return await Promise.race(signals);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}
