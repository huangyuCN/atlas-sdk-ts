// 战斗直连的帧侧小工具（纯函数，从 session.ts 拆出控制单文件规模）：
//   - 帧广播载荷的帧号提取（ver=1 protojson 的 frame.frameId，uint64 下发为字符串）；
//   - 读循环退出 / 写帧失败的错误归类（与内核 readloop/channel 同口径）；
//   - 建连失败的重试准入与归类（升级阶段 vs 升级后恢复、票类拒绝 vs 网络抖动）；
//   - 字面量对象判定（请求体补 battleId 时区分生成 DTO 实例）。
import { BusinessError, NetworkError, ProtocolError } from '../client/errors.js';
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';
import { decodeUtf8 } from '../frame/utf8.js';
import { edgeRejectedError } from './errors.js';

/** ConnectPhase 一次建连尝试的阶段（升级 vs 升级后的入局/补帧恢复）。 */
export type ConnectPhase = 'dial' | 'restore';

/** RetryGate 重连退避的准入条件（每次尝试前由会话按当前情形组装）。 */
export interface RetryGate {
  /** 本次是否重连（首连失败不重试：票刚拿到就失败，退避重试无意义）。 */
  isReconnect: boolean;
  /** 会话是否已进入关闭流程（关闭打断退避，不再重试）。 */
  closing: boolean;
  /** 会话是否已进终态（对局结束：不再重试——同一张票再拨也只会被 BATTLE_ENDED 拒）。 */
  ended: boolean;
  /** 重连窗口截止时刻（ms 时间戳；窗口用尽即判定接入层拒连）。 */
  deadline: number;
}

/** canRetry 判定是否在重连窗口内继续尝试：业务拒绝/协议错误/已判拒连一律不重试。 */
export function canRetry(gate: RetryGate, err: unknown): boolean {
  if (!gate.isReconnect || gate.closing || gate.ended || Date.now() >= gate.deadline) return false;
  if (err instanceof BusinessError || err instanceof ProtocolError) return false;
  if (err instanceof FrameProtocolError) return false;
  if (err instanceof NetworkError && !err.retryable) return false;
  return true;
}

/** classifyFailure 归类建连失败：票类业务拒绝与协议错误原样上抛（可判定）；
 *  升级阶段被断、或升级后未收到任何回执即被断 → 接入层拒连（不可重试）。 */
export function classifyFailure(phase: ConnectPhase, err: unknown, receivedAny: boolean): unknown {
  if (err instanceof BusinessError || err instanceof ProtocolError || err instanceof FrameProtocolError) {
    return err;
  }
  if (err instanceof NetworkError && !err.retryable) return err;
  if (phase === 'restore' && receivedAny) return err; // 已有回执：按网络断开（可重试语义）
  if (err instanceof NetworkError) {
    const why = phase === 'dial' ? '升级阶段被断开' : '升级后无回执即被断开';
    return edgeRejectedError(`战斗直连接入层拒连（${why}）：票可能已失效，请回业务链路重新取票`, err);
  }
  return err; // TimeoutError 等：原样上抛
}

/** safeCall 安全调用业务回调（异常隔离：回调抛错不影响读循环与心跳循环的续跑）。 */
export function safeCall(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    // 回调异常隔离：只吞回调自身的异常
  }
}

/** classifyExit 读循环退出错误归类：协议非法原样（终止不重连），其余归网络错误。 */
export function classifyExit(err: unknown): NetworkError | ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof FrameProtocolError) return new ProtocolError('战斗直连帧协议非法', err);
  if (err instanceof NetworkError) return err;
  return new NetworkError(err instanceof Error ? err.message : String(err));
}

/** classifyWriteError 归类写帧失败：本地协议错误保留身份（配置问题，不误判网络）。 */
export function classifyWriteError(err: unknown): NetworkError | ProtocolError {
  if (err instanceof ProtocolError) return err;
  return new NetworkError('发送失败: ' + (err instanceof Error ? err.message : String(err)), err);
}

/** frameIdOfProtojson 从 protojson 帧广播载荷取帧号（uint64 下发为字符串）。 */
export function frameIdOfProtojson(payload: Uint8Array): number {
  try {
    const obj = JSON.parse(decodeUtf8(payload)) as { frame?: { frameId?: unknown } };
    return toFrameId(obj.frame?.frameId);
  } catch {
    return -1;
  }
}

/** toFrameId 归一帧号（字符串/数值皆可；非法返回 -1）。 */
export function toFrameId(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/** isPlainObject 判定字面量对象（数组/null 不算）。 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** withBattleId 补齐客体寻址字段：字面量对象合并 battleId（显式值优先），
 *  生成 DTO 实例原样透传（其 battleId 由调用方设置）。 */
export function withBattleId(battleId: string, req: unknown): unknown {
  if (req === undefined || req === null) return { battleId };
  if (!isPlainObject(req)) return req;
  return { battleId, ...req };
}

/** syncRequest 组补帧请求：uint64 按 protojson 约定下发**字符串**。 */
export function syncRequest(battleId: string, frame: number): Record<string, unknown> {
  const n = Number.isFinite(frame) && frame > 0 ? Math.trunc(frame) : 0;
  return { battleId, lastSeenFrame: String(n) };
}
