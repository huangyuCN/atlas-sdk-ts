// 重连编排（supervisor）：每通道一个循环——退避重拨 → 建代 → 读循环 → 钩子同步
// 执行（hookBypass 直通窗口）→ 置 Connected 并 drain 排队 → 等本代死亡 → 循环。
// 首次连接无钩子直接置 Connected；协议级致命错误终止不重连；Close 打断退避。
import type { Channel } from './channel.js';
import { startChannelHeartbeats } from './heartbeat.js';
import { startReadLoop } from './readloop.js';

/** 在 d 的 ±20% 范围内抖动，避免断线风暴下的重连同步（对齐 Go jitter）。 */
export function jitter(d: number): number {
  if (d <= 0) return 0;
  const delta = Math.floor(d / 5);
  return d - delta + Math.floor(Math.random() * (2 * delta + 1));
}

/** 第 attempt 次（0 起）重连的退避时长：base ×2^attempt 封顶 max。 */
export function backoffDelay(baseMs: number, maxMs: number, attempt: number): number {
  const d = baseMs * 2 ** attempt;
  return jitter(Math.min(d, maxMs));
}

/** 可被关闭信号打断的睡眠；被打断返回 false。 */
export async function sleepInterruptible(ms: number, closedSignal: Promise<void>): Promise<boolean> {
  if (ms <= 0) return true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
      closedSignal.then(() => false),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 通道重连编排主循环（Client 构造时启动）。
 * 首连：不退避、不执行钩子；拨号失败拒绝首连等待者并停止（对齐 Dial 失败语义）。
 * 重连：退避重拨 → 钩子同步执行（hookBypass 直通窗口，超时弃用本代）→ 置
 * Connected 并 drain 排队（FIFO）→ 等本代死亡 → 循环；协议级致命终止不重连。 */
export async function supervise(ch: Channel): Promise<void> {
  let isReconnect = false;
  let attempt = 0;
  while (!ch.closed) {
    // 重连退避（带 ±20% 抖动；可被 Close 打断）。
    if (isReconnect) {
      if (!ch.settings.autoReconnect) {
        ch.setState('disconnected');
        return; // 关闭自动重连：连接死亡后进入 disconnected 终态
      }
      const delay = backoffDelay(ch.settings.backoffBaseMs, ch.settings.backoffMaxMs, attempt);
      if (!(await sleepInterruptible(delay, ch.onClosed))) return;
    }
    ch.setState(isReconnect ? 'reconnecting' : 'connecting');

    // 拨号：首连失败拒绝首连等待者并停止；重连失败退避重试。
    let tr;
    try {
      tr = await ch.dialer(ch.dialConfig);
    } catch (err) {
      if (!isReconnect) {
        ch.failFirstConnect(err);
        return;
      }
      attempt += 1;
      continue;
    }
    // 拨号返回后复查关闭状态（评审 Blocker：慢拨号在途时 close，返回后若直接
    // 建代启动读循环，读循环不会退出 → close 永久挂起并泄漏新 transport）。
    if (ch.closed) {
      tr.close();
      return;
    }
    const gen = ch.makeGeneration(tr);
    startReadLoop(ch, gen);
    startChannelHeartbeats(ch, gen);

    // 重连钩子同步执行（仅重连场景；首连无会话可恢复）：期间通道保持
    // Reconnecting（外部请求排队、不外发未认证请求），hookBypass 使钩子的
    // Invoke 直通当前代连接；超时视为失败——弃用本代连接，退避后重试。
    if (isReconnect && ch.settings.onReconnected) {
      const hookErr = await ch.runHook(gen);
      if (hookErr || ch.closed) {
        ch.closeTransport();
        if (ch.closed) return;
        // 评审缺陷修复：钩子执行期间读循环可能已检测到协议致命错误
        // （protocolFatal 置位）——必须终止不重连，否则 continue 会绕过
        // 下方 protocolFatal 检查继续拨号。
        if (ch.protocolFatal) {
          ch.setState('disconnected');
          return;
        }
        attempt += 1;
        continue;
      }
    }

    // 置 Connected 并 drain 排队（FIFO：排队请求严格先于新请求）。
    ch.settleGeneration();
    attempt = 0;
    isReconnect = true;

    // 等本代死亡（读循环退出 / 被杀）。
    await gen.done;
    if (ch.closed) return;
    if (ch.protocolFatal) {
      ch.setState('disconnected');
      return; // 协议级致命：终止不重连
    }
  }
}
