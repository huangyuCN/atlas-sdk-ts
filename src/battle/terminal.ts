// 不可重试终态的收口器（终态族里除「对局已结束」以外的三种：对局不存在 / 对局已满 /
// 票面对局与正文目标不一致），外加**心跳被业务拒绝**的分类处置（评审 R3-P1①②）。
//
// 为什么要单独收口：
//   1. 这些拒绝都**不可重试**（同一张票再拨只会撞同一拒绝），会话必须一次性终态化：
//      停心跳、结算在途、释放连接、上报——不留悬挂 socket 与悬挂定时器；
//   2. 心跳是 Tell（无 pending），它的回执会被「迟到结果」路径丢弃，业务拒绝因此
//      **完全不可见**——必须单独记账并按类处置（终态族 / 票类 / 其余）。
// 边界：终态不可逆（一旦置位，close() 也不清除，close 只把状态转 closed）；上报恰一次。
import type { BusinessError } from '../client/errors.js';
import type { Status } from '../frame/status.js';
import {
  BATTLE_ENDED_REASON,
  battleTerminalStatus,
  businessErrorOf,
  isBattleTerminalReason,
  isBattleTicketReason,
} from './errors.js';
import type { BattleStats } from './stats.js';

/** TerminalHooks 终态收口与会话的接缝（会话注入；本类不持有连接与定时器）。 */
export interface TerminalHooks {
  /** 运行统计（心跳被拒与终态计数）。 */
  readonly counters: BattleStats;
  /** 停心跳（幂等）。 */
  stopHeartbeat(): void;
  /** 清收尾窗口定时器（幂等）。 */
  disposeEnding(): void;
  /** 以同一 Status 结算全部在途请求（终态 Status 本地结算）。 */
  settleAll(status: Status): void;
  /** 置失败态（关闭保护由会话的 setState 实现）。 */
  setFailed(): void;
  /** 上报失败（onFailed；异常隔离由会话实现）。 */
  report(err: BusinessError): void;
  /** 心跳失败出口（票类「需重新取票」与其余业务拒绝走这里）。 */
  reportHeartbeat(err: BusinessError): void;
  /** 对局结束收口（BATTLE_ENDED：停发 + 收尾窗口，由 ending 负责）。 */
  endBattle(): void;
  /** 释放连接（幂等）。 */
  release(): void;
}

export class BattleTerminal {
  private fatal: BusinessError | null = null;
  private reticketReported = false;

  constructor(private readonly hooks: TerminalHooks) {}

  /** isFatal 是否已进不可重试终态（不可逆）。 */
  isFatal(): boolean {
    return this.fatal !== null;
  }

  /** error 终态错误（未终态为 null）：一切上发据此本地拒绝。 */
  error(): BusinessError | null {
    return this.fatal;
  }

  /** reject 业务拒绝的终态收口（收帧面在**结算之前**调用，心跳回执也走这里）：
   *  BATTLE_ENDED 交结束收口（保留收尾窗口读完结算推送），其余终态族置不可重试终态。 */
  reject(status: Status): void {
    if (status.reason === BATTLE_ENDED_REASON) {
      this.hooks.endBattle();
      return;
    }
    if (isBattleTerminalReason(status.reason)) this.enter(status);
  }

  /** onHeartbeatRejected 心跳回执被业务拒绝：终态族 → 入终态；票类 → 不终态，计数 +
   *  首见上报一次「需重新取票」信号（状态未变化不再重复上报，免得每拍刷屏）；
   *  其余业务拒绝 → 计数 + 每次经心跳失败出口暴露，继续探测（心跳从不触发重连）。 */
  onHeartbeatRejected(status: Status): void {
    const counters = this.hooks.counters;
    counters.heartbeatRejected += 1;
    counters.lastHeartbeatRejectReason = status.reason;
    if (isBattleTerminalReason(status.reason)) {
      this.reject(status);
      return;
    }
    const err = businessErrorOf(status);
    if (!isBattleTicketReason(status.reason)) {
      this.hooks.reportHeartbeat(err);
      return;
    }
    counters.heartbeatTicketRejected += 1;
    if (this.reticketReported) return;
    this.reticketReported = true;
    this.hooks.reportHeartbeat(err);
  }

  /** enter 置不可重试终态：在途请求以**终态 Status** 本地结算（不等回执、不等超时、
   *  不报成网络错误），停心跳、释放连接，并经既有失败出口上报一次（幂等）。
   *  统计归「无结算的终态拒绝」族（fatalRejects；与 endedRejects 区分：没有结算可展示）。 */
  private enter(status: Status): void {
    if (this.fatal !== null) return;
    const local = battleTerminalStatus(status);
    this.fatal = businessErrorOf(local);
    this.hooks.counters.fatalRejects += 1;
    this.hooks.stopHeartbeat();
    this.hooks.disposeEnding();
    this.hooks.settleAll(local);
    this.hooks.setFailed();
    this.hooks.report(this.fatal);
    this.hooks.release(); // 会话无用：连接即刻回收（不占 socket、不留悬挂读循环）
  }
}
