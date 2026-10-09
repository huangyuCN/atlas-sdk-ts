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
//
// **终态族**（三 SDK 一致性契约，评审 R3-P1）：不可重试、终态化并上报的业务拒绝，
// 判定函数与常量与 BATTLE_ENDED 同族（isBattleTerminalReject 一处判定）：
//   - BATTLE_ENDED（409，biz 3003）：对局已结束 → 停发 + 收尾窗口（结算推送仍要读完）；
//   - BATTLE_NOT_FOUND（404，biz 3001）：对局不存在 → 会话无用，不重连；
//   - BATTLE_FULL（409，biz 3002）：入局被拒（名额满）→ 会话无用，不重连；
//   - FRAME_TARGET_MISMATCH（403）：票面对局与请求正文目标不一致（框架失败关闭，
//     正常 SDK 不会产生）→ 客户端/协议侧错误，重试只会撞同一拒绝。
// 票类（BATTLE_TICKET_INVALID/EXPIRED）**不在**终态族：那是「回业务链路重新取票」的信号。
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
/** BATTLE_NOT_FOUND_REASON 对局不存在（battle 侧 404 reason，biz_code 3001）：终态族，
 *  会话无用（不重连），上报后可回匹配链路重新开局。 */
export const BATTLE_NOT_FOUND_REASON = 'BATTLE_NOT_FOUND';
/** BATTLE_NOT_FOUND_CODE 服务端 ErrBattleNotFound 的状态码口径（404）。 */
export const BATTLE_NOT_FOUND_CODE = 404;
/** BATTLE_FULL_REASON 对局已满（battle 侧 409 reason，biz_code 3002）：终态族，
 *  入局被拒即会话无用（不重连）。 */
export const BATTLE_FULL_REASON = 'BATTLE_FULL';
/** BATTLE_FULL_CODE 服务端 ErrBattleFull 的状态码口径（409，与 BATTLE_ENDED 同码不同 reason）。 */
export const BATTLE_FULL_CODE = 409;
/** FRAME_TARGET_MISMATCH_REASON 票面对局与请求正文目标不一致（帧面 403 reason）：
 *  框架侧失败关闭（防「用一张合法票拉起任意 battle actor」），正常 SDK 不会产生。 */
export const FRAME_TARGET_MISMATCH_REASON = 'FRAME_TARGET_MISMATCH';
/** FRAME_TARGET_MISMATCH_CODE 服务端该拒绝的状态码口径（403）。 */
export const FRAME_TARGET_MISMATCH_CODE = 403;
/** LOCAL_SETTLED_KEY 本地**结算**的 metadata 标记键（ended / failed 两族终态通用）：
 *  终态到达时在途请求以终态 Status 立即了结（本地终态拒绝的错误形态同样带本键），
 *  该回执不是服务端原样下发，排障时据此区分。
 *  **三 SDK 统一键名（`x-atlas-sdk-local-settled`），勿各写一套**——本轮审计发现
 *  TS/C#/Go 三仓曾各不相同（local-ended / local-settlement / local-ended），
 *  按平台分叉会让排障口径在跨端日志里对不上。 */
export const LOCAL_SETTLED_KEY = 'x-atlas-sdk-local-settled';
/** ENDED_MESSAGE 本地终态拒绝的默认文案（错误与 Status 两种形态共用，保证同形）。 */
const ENDED_MESSAGE = '对局已结束：会话已进入终态，不再上发任何帧';
/** BUSINESS_CLASS 业务错误类（与服务端 ErrBattleEnded 的 `.WithClass(ClassBusiness)` 对齐：
 *  日志按类定级、不计入故障率——本地拒绝不能因为「是 SDK 生成的」就换了分类）。 */
export const BUSINESS_CLASS = 1;

/** isBattleTicketExpired 判定「票过期」业务拒绝（上层据此回业务链路重新匹配）。 */
export function isBattleTicketExpired(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === BATTLE_TICKET_EXPIRED_REASON;
}

/** isBattleTicketReason 判定票类 reason（过期或无效）：需要重新取票，不是终态。 */
export function isBattleTicketReason(reason: string): boolean {
  return reason === BATTLE_TICKET_EXPIRED_REASON || reason === BATTLE_TICKET_INVALID_REASON;
}

/** isBattleTicketRejected 判定票据类业务拒绝（过期或无效）。 */
export function isBattleTicketRejected(err: unknown): err is BusinessError {
  return err instanceof BusinessError && isBattleTicketReason(err.reason);
}

/** isBattleEnded 判定「对局已结束」业务拒绝：服务端原样拒绝与本地终态拒绝共用本入口
 *  （两者同 code/reason，调用方一处判定即可，不必区分是谁先发现的）。 */
export function isBattleEnded(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === BATTLE_ENDED_REASON;
}

/** isBattleNotFound 判定「对局不存在」业务拒绝（终态族：不可重试，回匹配链路重新开局）。 */
export function isBattleNotFound(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === BATTLE_NOT_FOUND_REASON;
}

/** isBattleFull 判定「对局已满」业务拒绝（终态族：不可重试）。 */
export function isBattleFull(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === BATTLE_FULL_REASON;
}

/** isFrameTargetMismatch 判定「票面对局与正文目标不一致」业务拒绝（终态族：
 *  客户端/协议侧错误，重试只会撞同一拒绝）。 */
export function isFrameTargetMismatch(err: unknown): err is BusinessError {
  return err instanceof BusinessError && err.reason === FRAME_TARGET_MISMATCH_REASON;
}

/** isBattleTerminalReason 判定终态族 reason（会话据此入终态停发；票类不在其列）。 */
export function isBattleTerminalReason(reason: string): boolean {
  return (
    reason === BATTLE_ENDED_REASON ||
    reason === BATTLE_NOT_FOUND_REASON ||
    reason === BATTLE_FULL_REASON ||
    reason === FRAME_TARGET_MISMATCH_REASON
  );
}

/** isBattleTerminalReject 判定「不可重试的终态业务拒绝」族（与 isBattleEnded 同族口径：
 *  常量 + 判定函数；调用方一处判定即可覆盖对局结束/不存在/已满/目标不一致四种）。 */
export function isBattleTerminalReject(err: unknown): err is BusinessError {
  return err instanceof BusinessError && isBattleTerminalReason(err.reason);
}

/** battleEndedError 构造本地终态拒绝（会话已进终态：再发帧只会撞同一拒绝、白占带宽；
 *  code/reason/class 与服务端回执一致，metadata 带统一本地结算键便于排障）。 */
export function battleEndedError(message: string = ENDED_MESSAGE): BusinessError {
  return new BusinessError(BATTLE_ENDED_CODE, BATTLE_ENDED_REASON, message, { [LOCAL_SETTLED_KEY]: 'true' }, BUSINESS_CLASS);
}

/** battleEndedStatus 本地终态拒绝的 **Status 形态**：在途请求按内核约定「业务拒绝以
 *  Status 结算」归一（unwrap 再还原成同形的 BusinessError），避免往结算错误的三分类
 *  （NetworkError/TimeoutError/ProtocolError）里塞业务拒绝。 */
export function battleEndedStatus(message: string = ENDED_MESSAGE): Status {
  return {
    code: BATTLE_ENDED_CODE,
    reason: BATTLE_ENDED_REASON,
    message,
    class: BUSINESS_CLASS,
    metadata: { [LOCAL_SETTLED_KEY]: 'true' },
  };
}

/** businessErrorOf 把内核 Status 还原为业务错误（服务端原样回执与本地结算共用一处映射，
 *  保证「远端拒的」与「本地结算的」对上层同形）。 */
export function businessErrorOf(status: Status): BusinessError {
  return new BusinessError(status.code, status.reason, status.message, status.metadata, status.class);
}

/** battleTerminalStatus 终态族的**本地结算 Status**（在途请求立即了结用）：
 *  reason/code 取服务端终态回执，class 归业务类，metadata 追加本地结算标记
 *  （服务端 metadata 原样保留，如 biz_code 便于排障）。 */
export function battleTerminalStatus(status: Status): Status {
  const message = status.message !== ''
    ? status.message
    : `终态业务拒绝（${status.reason}）：会话已停止，不再上发任何帧`;
  return {
    code: status.code,
    reason: status.reason,
    message,
    class: status.class > 0 ? status.class : BUSINESS_CLASS,
    metadata: { ...(status.metadata ?? {}), [LOCAL_SETTLED_KEY]: 'true' },
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
