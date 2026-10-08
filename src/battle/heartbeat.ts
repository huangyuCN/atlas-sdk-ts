// 战斗直连保活心跳的执行体（Tell，无回执）：无输入期间周期发出 Ping，让帧面保持活跃。
//
// 为什么需要它：battle 侧帧引擎以「收到任何合法帧」刷新空闲读超时（缺省取
// offline_timeout/3 = 5s，见 services/battle 的 frames/Ping 说明），静默超时即被拆流；
// 数据报面静默还会让 NAT 映射失效。故客户端必须在无输入期间主动发帧。
//
// 语义（与本仓内核 transportHeartbeatLoop 同口径，但**不做死链判定**）：
//   - 单循环：上一拍完成后才排下一拍（自续期 setTimeout），拍与拍不重叠；
//   - 按代启停：stop() 立即清定时器（不泄漏），并作废在途的一拍（换代码路径不会并存两条循环）；
//   - 失败容忍：一拍失败只回调（回调自身异常同样隔离），绝不终止会话、不改会话状态。
export interface HeartbeatHooks {
  /** 发送周期（毫秒；<= 0 表示显式关闭）。 */
  periodMs: number;
  /** 每拍动作（发送 Ping；抛错即本拍失败）。 */
  beat: () => void | Promise<void>;
  /** 失败回调（异常隔离；不改变心跳循环是否继续）。 */
  onError: (err: unknown) => void;
}

export class BattleHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;

  constructor(private readonly hooks: HeartbeatHooks) {}

  /** start 启动心跳循环（已启动/周期非正即幂等跳过）。 */
  start(): void {
    if (!this.stopped || this.hooks.periodMs <= 0) return;
    this.stopped = false;
    this.schedule(++this.generation);
  }

  /** stop 停止心跳并清定时器（幂等）：调用后不再有任何待触发的计时器。 */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** schedule 排下一拍（停止或换代即不排；gen 标识本轮循环）。 */
  private schedule(gen: number): void {
    if (this.stopped || gen !== this.generation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire(gen);
    }, this.hooks.periodMs);
  }

  /** fire 一拍：失败交 onError，随后续排下一拍。 */
  private async fire(gen: number): Promise<void> {
    if (this.stopped || gen !== this.generation) return;
    try {
      await this.hooks.beat();
    } catch (err) {
      this.report(err);
    }
    this.schedule(gen);
  }

  /** report 上报失败（回调异常隔离，不影响循环续拍）。 */
  private report(err: unknown): void {
    try {
      this.hooks.onError(err);
    } catch {
      // 回调异常隔离
    }
  }
}
