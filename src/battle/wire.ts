// 战斗直连的帧侧小工具（纯函数，从 session.ts 拆出控制单文件规模）：
//   - 读循环退出 / 写帧失败的错误归类（与内核 readloop/channel 同口径）；
//   - 建连失败的重试准入与归类（升级阶段 vs 升级后重放、票类拒绝 vs 网络抖动）。
// 游戏域消息的载荷构造/解析不在这里（已迁出 SDK：帧号由调用方注入钩子，载荷原样透传）。
import { BusinessError, NetworkError, ProtocolError } from '../client/errors.js';
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';
import { VERSION, VERSION_2 } from '../frame/constants.js';
import { edgeRejectedError } from './errors.js';

/** isSupportedPayloadVersion 判定载荷编码版本是否在白名单 {1,2} 内：ver=1（protojson，
 *  调试开关）与 ver=2（protobuf 二进制）放行；其余版本未知——明确报错，绝不「猜编码再解码」。
 *  与 Go 的 supportedVersion 同口径（帧层另有生成物的白名单校验，两层各守一段）。 */
export function isSupportedPayloadVersion(version: number): boolean {
  return version === VERSION || version === VERSION_2;
}

/** ConnectPhase 一次建连尝试的阶段（升级 vs 升级后的重放）。 */
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

/** classifyExit 读循环退出错误归类：协议非法原样（终止不重连），其余归网络错误。
 *  帧层错误（如帧头版本不在白名单）**保留原因文本**——只报「帧协议非法」会把
 *  「ver=3 未知版本」这类可判定原因吞掉，排障时无从下手。 */
export function classifyExit(err: unknown): NetworkError | ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof FrameProtocolError) return new ProtocolError(`战斗直连帧协议非法：${err.message}`, err);
  if (err instanceof NetworkError) return err;
  return new NetworkError(err instanceof Error ? err.message : String(err));
}

/** classifyWriteError 归类写帧失败：本地协议错误保留身份（配置问题，不误判网络）。 */
export function classifyWriteError(err: unknown): NetworkError | ProtocolError {
  if (err instanceof ProtocolError) return err;
  return new NetworkError('发送失败: ' + (err instanceof Error ? err.message : String(err)), err);
}
