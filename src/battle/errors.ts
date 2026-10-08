// 战斗直连的错误分类辅助（不新增异常类型族：全部复用内核既有四分类）。
//
// 规格 §7 要求 SDK 区分四件事，判定入口在本文件：
//   1. 接入层拒连（L4 断开 + 无应用层回执）：NetworkError 且 retryable=false
//      —— isEdgeRejected 判定；**不重试**，回业务链路重新取票；
//   2. battle 侧票据结构化拒绝：BusinessError（reason 为 BATTLE_TICKET_*）
//      —— isBattleTicketExpired / isBusinessError(err, reason) 判定；
//   3. 对局已结束的稳定拒绝：BusinessError（reason = BATTLE_ENDED）——isBattleEnded 判定；
//      会话据此进终态停发（**与票据类拒绝互斥**：票据拒绝要重新取票，本拒绝要收尾）；
//   4. 纯网络断开：NetworkError（retryable=true，退避重连）。
import { BusinessError, NetworkError } from '../client/errors.js';
import type { Status } from '../frame/status.js';

/** BATTLE_TICKET_INVALID_REASON 票无效/缺失（battle 侧 401 reason）。 */
export const BATTLE_TICKET_INVALID_REASON = 'BATTLE_TICKET_INVALID';
/** BATTLE_TICKET_EXPIRED_REASON 票已过期（battle 侧 401 reason；与无效分开，
 *  客户端据此决定「重新取票」而不是「修票」）。 */
export const BATTLE_TICKET_EXPIRED_REASON = 'BATTLE_TICKET_EXPIRED';
/** BATTLE_ENDED_REASON 对局已结束（battle 侧 409 reason）。语义是「该对局已结束」：
 *  已结束的对局对**任何**迟到帧 op（含心跳 Ping）都回这个 reason，客户端据此
 *  **停止发送**并转向结算展示，而不是重试到超时。 */
export const BATTLE_ENDED_REASON = 'BATTLE_ENDED';
/** BATTLE_ENDED_CODE 服务端 ErrBattleEnded 的状态码口径（本地终态拒绝沿用同一 code，
 *  让「远端真的拒了」与「本地已终态不再发」对上层是同一个判定）。 */
export const BATTLE_ENDED_CODE = 409;
/** LOCAL_ENDED_KEY 本地终态拒绝的 metadata 标记键：排障时据此区分「服务端回的
 *  BATTLE_ENDED」与「SDK 因终态本地拒绝」（业务分支只看 reason，不依赖本键）。 */
export const LOCAL_ENDED_KEY = 'x-atlas-sdk-local-ended';
/** ENDED_MESSAGE 本地终态拒绝的默认文案（错误与 Status 两种形态共用，保证同形）。 */
const ENDED_MESSAGE = '对局已结束：会话已进入终态，不再上发任何帧';
/** ENDED_CLASS 业务错误类（与服务端 ErrBattleEnded 的 `.WithClass(ClassBusiness)` 对齐：
 *  日志按类定级、不计入故障率——本地拒绝不能因为「是 SDK 生成的」就换了分类）。 */
const ENDED_CLASS = 1;

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

/** isBattleEnded 判定「对局已结束」业务拒绝：服务端原样拒绝与本地终态拒绝共用本入口
 *  （两者同 code/reason，调用方一处判定即可，不必区分是谁先发现的）。 */
export function isBattleEnded(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === BATTLE_ENDED_REASON;
}

/** battleEndedError 构造本地终态拒绝（会话已进终态：再发帧只会撞同一拒绝、白占带宽；
 *  code/reason/class 与服务端回执一致，metadata 标记本地来源便于排障）。 */
export function battleEndedError(message: string = ENDED_MESSAGE): BusinessError {
  return new BusinessError(BATTLE_ENDED_CODE, BATTLE_ENDED_REASON, message, { [LOCAL_ENDED_KEY]: 'true' }, ENDED_CLASS);
}

/** battleEndedStatus 本地终态拒绝的 **Status 形态**：在途请求按内核约定「业务拒绝以
 *  Status 结算」归一（unwrap 再还原成同形的 BusinessError），避免往结算错误的三分类
 *  （NetworkError/TimeoutError/ProtocolError）里塞业务拒绝。 */
export function battleEndedStatus(message: string = ENDED_MESSAGE): Status {
  return {
    code: BATTLE_ENDED_CODE,
    reason: BATTLE_ENDED_REASON,
    message,
    class: ENDED_CLASS,
    metadata: { [LOCAL_ENDED_KEY]: 'true' },
  };
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
