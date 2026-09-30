// 战斗直连的错误分类辅助（不新增异常类型族：全部复用内核既有四分类）。
//
// 规格 §7 要求 SDK 区分三件事，判定入口在本文件：
//   1. 接入层拒连（L4 断开 + 无应用层回执）：NetworkError 且 retryable=false
//      —— isEdgeRejected 判定；**不重试**，回业务链路重新取票；
//   2. battle 侧票据结构化拒绝：BusinessError（reason 为 BATTLE_TICKET_*）
//      —— isBattleTicketExpired / isBusinessError(err, reason) 判定；
//   3. 纯网络断开：NetworkError（retryable=true，退避重连）。
import { BusinessError, NetworkError } from '../client/errors.js';

/** BATTLE_TICKET_INVALID_REASON 票无效/缺失（battle 侧 401 reason）。 */
export const BATTLE_TICKET_INVALID_REASON = 'BATTLE_TICKET_INVALID';
/** BATTLE_TICKET_EXPIRED_REASON 票已过期（battle 侧 401 reason；与无效分开，
 *  客户端据此决定「重新取票」而不是「修票」）。 */
export const BATTLE_TICKET_EXPIRED_REASON = 'BATTLE_TICKET_EXPIRED';

/** isBattleTicketExpired 判定「票过期」业务拒绝（上层据此回业务链路重新匹配）。 */
export function isBattleTicketExpired(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === BATTLE_TICKET_EXPIRED_REASON;
}

/** isBattleTicketRejected 判定票据类业务拒绝（过期或无效）。 */
export function isBattleTicketRejected(err: unknown): err is BusinessError {
  return (
    err instanceof BusinessError &&
    (err.reason === BATTLE_TICKET_EXPIRED_REASON || err.reason === BATTLE_TICKET_INVALID_REASON)
  );
}

/** isEdgeRejected 判定「接入层拒连」（不可重试的网络错误）。 */
export function isEdgeRejected(err: unknown): err is NetworkError {
  return err instanceof NetworkError && !err.retryable;
}

/** edgeRejectedError 构造接入层拒连错误（既有 NetworkError + retryable=false，
 *  原因是浏览器侧无法区分「接入层验票后断开」与「TCP 连不上」——都表现为
 *  升级未完成/无回执；统一按「不重试」处理，由上层决定是否重新取票）。 */
export function edgeRejectedError(message: string, cause?: unknown): NetworkError {
  const err = new NetworkError(message, cause);
  err.retryable = false;
  return err;
}
