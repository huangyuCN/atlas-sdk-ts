// 战斗直连的帧侧小工具（纯函数，从 session.ts 拆出控制单文件规模）：
//   - 帧广播载荷的帧号提取（ver=1 protojson 的 frame.frameId，uint64 下发为字符串）；
//   - 读循环退出 / 写帧失败的错误归类（与内核 readloop/channel 同口径）；
//   - 字面量对象判定（请求体补 battleId 时区分生成 DTO 实例）。
import { NetworkError, ProtocolError } from '../client/errors.js';
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';
import { decodeUtf8 } from '../frame/utf8.js';

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
