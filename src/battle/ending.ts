// 对局结束的收口器（终态独占，从 session.ts 拆出控制单文件规模）：把「结束通知」与
// 「BATTLE_ENDED 业务拒绝」两条信号收敛成**一个不可逆终态**与**一次结算回调**，
// 并独占收尾窗口的定时器。
//
// 为什么需要单点收口（跨机验收暴露的三件事）：
//   1. **重复投递**：结算关闭前服务端对每条未确认连接重投 EndRetries=2 次结算通知
//      （CloseBattle → repushEnd），玩家带票重连再按 MaxEndReplays=5 有界补投
//      （ReplayEnd）——同一份通知会重复到达，业务回调必须**恰一次**（否则重复结算展示、
//      重复发奖）。同一局的载荷由服务端留档（EndedBook）唯一确定、逐字一致；
//      若出现不一致副本，以**先到者为准**（结算不可改判）：既不回第二遍，也不改判，
//      该副本不从任何出口出去（补投在统一出口不可见，与 Go/C# 同口径）。
//   2. **终态即时停发**：对局结束后服务端对任何迟到帧 op（含心跳 Ping）一律回
//      BATTLE_ENDED——客户端若不停，就是对着已结束的对局持续刷帧。
//   3. **有界收尾窗口**：结算结果与最后一帧可能仍在途，停发之后要留一段窗口把连接上
//      剩下的结果读完再释放（服务端在流式面会先关，客户端会先收到断开事件；数据报面
//      没有关闭事件，窗口就是兜底回收）。窗口必须**有界**且定时器**归本类独占**。
//
// 边界：终态不可逆（isEnded 一旦为真永久为真，close() 也不清除）；定时器一旦 dispose()
// 便不再有任何待触发的窗口回调（无泄漏）。**空载荷不构成结束信号**（跨 SDK 统一契约，
// 见 absorb 的注释）——它既不进终态，也不占用「首投」这一名额。
export interface EndingHooks {
  /** 收尾窗口（ms；<= 0 表示置终态即释放，不等待）。 */
  drainMs: number;
  /** 首次进入终态时的收尾动作（停心跳、结算在途请求；由会话注入）。 */
  onEnded: () => void;
  /** 收尾窗口到点：释放连接（由会话注入；须幂等）。 */
  onDrain: () => void;
}

/** EndNotifyDisposition 一条结束通知的处置：'empty' = 空载荷不算结束信号（不占用首投
 *  名额）、'first' = 首投（进终态并回调一次）、'replay' = 重复副本（不改判、不重放回调、
 *  也不从任何出口出去——收帧面对非 'first' 一律提前返回）。 */
export type EndNotifyDisposition = 'empty' | 'first' | 'replay';

export class BattleEnding {
  private ended = false;
  private sealed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly hooks: EndingHooks) {}

  /** isEnded 是否已进入终态（永久为真；close() 不清除，故「是对局结束」始终可判定）。 */
  isEnded(): boolean {
    return this.ended;
  }

  /** end 由稳定拒绝（BATTLE_ENDED）置终态：无结算载荷，幂等。 */
  end(): void {
    this.mark();
  }

  /** absorb 吸收一条结束通知：'first' = **首份结算**（调用方回调一次业务）、'replay' =
   *  重复副本（不改判、不回第二遍、也不分发）、'empty' = 空载荷（**不构成结束信号**）。
   *
   *  空载荷与补投判据是**跨 SDK 统一契约**（改这里之前先看另外两份实现，三语言必须同口径）：
   *  Go `direct/ended.go` 的 noteEndNotify 以 `len(payload) == 0` 提前返回、C#
   *  `BattleSession.Ended.cs` 的 NoteEndNotify 以 `payload.Length == 0` 提前返回——都
   *  **不进终态、不回调、不分发**（补投同理：只有首投可见）。空载荷还必须**不占用首投
   *  名额**（不置 sealed、不启动收尾窗口）：否则随后到达的真正结算会被当补投副本丢弃，
   *  结算永久丢失且无处取回。
   */
  absorb(payload: Uint8Array): EndNotifyDisposition {
    if (payload.length === 0) return 'empty';
    if (this.sealed) return 'replay';
    this.sealed = true;
    this.mark();
    return 'first';
  }

  /** dispose 释放收尾窗口定时器：调用后不再有窗口回调（close / 连接已死时调用）。 */
  dispose(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** mark 置终态并启动收尾窗口（幂等：只收尾一次、窗口只排一个）。 */
  private mark(): void {
    if (this.ended) return;
    this.ended = true;
    this.hooks.onEnded();
    if (this.hooks.drainMs <= 0) {
      this.hooks.onDrain();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.hooks.onDrain();
    }, this.hooks.drainMs);
  }
}
