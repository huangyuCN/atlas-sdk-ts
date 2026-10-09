// 战斗直连的可观测统计（评审 P1-4：重连 / 握手（拨号）/ 心跳失败计数）。
//
// 口径（不引任何依赖：内部是普通计数器，对外只给 Object.freeze 的只读快照）：
//   - 握手失败 = 拨号（升级）未完成/被拒/超时；重连成功单列，便于算成功率；
//   - 心跳**本地写失败**与**被业务拒绝**分开计（前者是链路/宿主问题，后者是服务端语义）；
//   - 心跳被拒里**票类**单列（「需重新取票」信号的当前状态，便于上层做一次性处置）；
//   - 终态次数单列（BATTLE_ENDED / BATTLE_NOT_FOUND / BATTLE_FULL / FRAME_TARGET_MISMATCH）。
// 快照语义：每次 stats() 都是**新对象**，调用方改它不影响会话内部计数。

/** BattleSessionStats 战斗直连会话的运行统计（只读快照；字段全为累计值）。 */
export interface BattleSessionStats {
  /** 拨号（含升级握手）尝试次数：首连 1 次，重连的每次尝试各 1 次。 */
  readonly dialAttempts: number;
  /** 拨号失败次数（升级未完成 / 被接入层拒 / 握手超时）。 */
  readonly dialFailures: number;
  /** 重连成功次数（不含首连）：进入 connected 且入局/补帧完成。 */
  readonly reconnects: number;
  /** 心跳写线失败次数（本地写/序列化失败；不含业务拒绝）。 */
  readonly heartbeatWriteFailures: number;
  /** 心跳被业务拒绝次数（回执为 Status；含终态类与票类）。 */
  readonly heartbeatRejected: number;
  /** 心跳被**票类**拒绝次数（BATTLE_TICKET_INVALID/EXPIRED：需回业务链路重新取票）。 */
  readonly heartbeatTicketRejected: number;
  /** 最近一次心跳被拒的 reason（未发生过为 null）。 */
  readonly lastHeartbeatRejectReason: string | null;
  /** 进入终态的**总**次数（= endedRejects + fatalRejects）。 */
  readonly terminalRejects: number;
  /** 「对局正常结束」进入终态的次数（BATTLE_ENDED 拒绝或结算推送）：**有结算可展示**，
   *  会话据此走 ended 语义（state='ended'、ended()=true、收尾窗口读结果）。 */
  readonly endedRejects: number;
  /** 「无结算的终态拒绝」次数（BATTLE_NOT_FOUND / BATTLE_FULL / FRAME_TARGET_MISMATCH）：
   *  会话无用，走 failed 语义（state='failed'、onFailed 上报）——与 endedRejects 的区别
   *  正是「没有结算可展示」，上层据此决定是否去取结算数据。 */
  readonly fatalRejects: number;
}

/** BattleStats 会话内部计数器（只在会话内可变；对外经 snapshot() 暴露只读快照）。 */
export class BattleStats {
  dialAttempts = 0;
  dialFailures = 0;
  reconnects = 0;
  heartbeatWriteFailures = 0;
  heartbeatRejected = 0;
  heartbeatTicketRejected = 0;
  lastHeartbeatRejectReason: string | null = null;
  endedRejects = 0;
  fatalRejects = 0;

  /** terminalRejects 终态总次数（两族之和；只读派生，不单独计数以免口径漂移）。 */
  get terminalRejects(): number {
    return this.endedRejects + this.fatalRejects;
  }

  /** snapshot 取只读快照（新对象 + freeze：调用方无法经快照改内部计数）。 */
  snapshot(): BattleSessionStats {
    return Object.freeze({
      dialAttempts: this.dialAttempts,
      dialFailures: this.dialFailures,
      reconnects: this.reconnects,
      heartbeatWriteFailures: this.heartbeatWriteFailures,
      heartbeatRejected: this.heartbeatRejected,
      heartbeatTicketRejected: this.heartbeatTicketRejected,
      lastHeartbeatRejectReason: this.lastHeartbeatRejectReason,
      terminalRejects: this.terminalRejects,
      endedRejects: this.endedRejects,
      fatalRejects: this.fatalRejects,
    });
  }
}
