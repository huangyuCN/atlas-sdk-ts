// 帧 body 构造与解析：[opLen:u16 大端][operation utf-8][payload]。
// 可选段按 flags 位序依序追加：会话槽（FLAG_SESSION）→ 请求幂等键（FLAG_REQUEST_ID）。
// 与服务端 transport/internal/client.BuildRawBody 格式一致。
// UTF-8 编解码走协议层自带实现（引擎宿主兼容加固——不依赖宿主 TextEncoder/TextDecoder）。
import {
  FLAG_REQUEST_ID,
  FLAG_SESSION,
  MAX_OPERATION_LEN,
  MAX_REQUEST_ID_LEN,
  MAX_SESSION_LEN,
} from './constants.js';
import { ProtocolError } from './protocolError.js';
import { decodeUtf8, encodeUtf8 } from './utf8.js';

/** 封装帧 body（与 Go frame.BuildRequestBody 对称）。
 * operation 空/超上限抛普通 Error——构造侧参数问题，非协议解析错误（与 Go 一致：
 * 服务端对超长 operation 回 ProtocolError 不断连，客户端构造侧校验提前拦）。 */
export function buildRequestBody(operation: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  return buildRequestBodyInternal(operation, '', '', payload);
}

/** 封装携带会话槽的请求 body（与 Go frame.BuildRequestBodyWithSession 对称）：
 * [opLen][operation][sessionLen][session][payload]，配合帧头 FLAG_SESSION 使用。
 * 无连接传输（UDP/KCP）的请求帧调用；session 为空时与无会话布局等价（匿名请求）。 */
export function buildRequestBodyWithSession(
  operation: string,
  session: string,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return buildRequestBodyFull(operation, session, '', payload);
}

/** 封装全部可选段（会话槽 + 请求幂等键，与 Go frame.BuildRequestBodyFull 对称）：
 * [opLen][operation][sessionLen][session][requestIDLen][requestID][payload]，
 * 空串段不写入（布局最小化）；调用方按置位的 flags 解析。 */
export function buildRequestBodyFull(
  operation: string,
  session: string,
  requestID: string,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return buildRequestBodyInternal(operation, session, requestID, payload);
}

/** body 封装的唯一实现源；session/requestID 非空时依序追加对应段。 */
function buildRequestBodyInternal(
  operation: string,
  session: string,
  requestID: string,
  payload: Uint8Array,
): Uint8Array {
  const opBytes = encodeUtf8(operation);
  if (opBytes.length === 0) {
    throw new Error('frame: operation 不能为空');
  }
  if (opBytes.length > MAX_OPERATION_LEN) {
    throw new Error(`frame: operation 长度 ${opBytes.length} 超过上限 ${MAX_OPERATION_LEN}`);
  }
  const sessionBytes = session === '' ? new Uint8Array(0) : encodeUtf8(session);
  if (sessionBytes.length > MAX_SESSION_LEN) {
    throw new Error(`frame: session 长度 ${sessionBytes.length} 超过上限 ${MAX_SESSION_LEN}`);
  }
  const idBytes = requestID === '' ? new Uint8Array(0) : encodeUtf8(requestID);
  if (idBytes.length > MAX_REQUEST_ID_LEN) {
    throw new Error(`frame: requestID 长度 ${idBytes.length} 超过上限 ${MAX_REQUEST_ID_LEN}`);
  }
  const total = sessionBytes.length + idBytes.length === 0
    ? 0
    : (sessionBytes.length === 0 ? 0 : 2 + sessionBytes.length) +
      (idBytes.length === 0 ? 0 : 2 + idBytes.length);
  const body = new Uint8Array(2 + opBytes.length + total + payload.length);
  body[0] = opBytes.length >> 8;
  body[1] = opBytes.length & 0xff;
  body.set(opBytes, 2);
  let off = 2 + opBytes.length;
  if (sessionBytes.length > 0) {
    body[off] = sessionBytes.length >> 8;
    body[off + 1] = sessionBytes.length & 0xff;
    body.set(sessionBytes, off + 2);
    off += 2 + sessionBytes.length;
  }
  if (idBytes.length > 0) {
    body[off] = idBytes.length >> 8;
    body[off + 1] = idBytes.length & 0xff;
    body.set(idBytes, off + 2);
    off += 2 + idBytes.length;
  }
  body.set(payload, off);
  return body;
}

/** 解析帧 body，返回 operation 与 payload（与 Go frame.ParseRequestBody 对称；
 * 不解析会话槽）。opLen 超上限/operation 截断均为协议非法（ProtocolError）。 */
export function parseRequestBody(body: Uint8Array): { operation: string; payload: Uint8Array } {
  const r = parseRequestBodyInternal(body, 0);
  return { operation: r.operation, payload: r.payload };
}

/** 解析携带会话槽的帧 body（与 Go frame.ParseRequestBodyWithSession 对称）：
 * flags 置位 FLAG_SESSION 时在 operation 后读会话槽；未置位 session 为空串、
 * payload 即余下字节。会话槽缺长度/截断均为协议非法（ProtocolError）。 */
export function parseRequestBodyWithSession(
  body: Uint8Array,
  flags: number,
): { operation: string; session: string; payload: Uint8Array } {
  const r = parseRequestBodyInternal(body, flags);
  return { operation: r.operation, session: r.session, payload: r.payload };
}

/** 解析帧 body 的全部可选段（与 Go frame.ParseRequestBodyFull 对称）：
 * 返回 operation、会话槽、请求幂等键与 payload（服务端五协议引擎同构）。 */
export function parseRequestBodyFull(
  body: Uint8Array,
  flags: number,
): { operation: string; session: string; requestID: string; payload: Uint8Array } {
  return parseRequestBodyInternal(body, flags);
}

/** body 统一解析：可选段按 flags 位序依序读取（会话槽 → 请求幂等键）。 */
function parseRequestBodyInternal(
  body: Uint8Array,
  flags: number,
): { operation: string; session: string; requestID: string; payload: Uint8Array } {
  if (body.length < 2) {
    throw new ProtocolError(`frame: body 过短，缺少 opLen`);
  }
  const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
  if (opLen > MAX_OPERATION_LEN) {
    throw new ProtocolError(`frame: operation 长度 ${opLen} 超过上限 ${MAX_OPERATION_LEN}`);
  }
  if (body.length < 2 + opLen) {
    throw new ProtocolError(`frame: operation 截断`);
  }
  const opBytes = body.subarray(2, 2 + opLen);
  let rest = body.subarray(2 + opLen);
  let session = '';
  let requestID = '';
  if ((flags & FLAG_SESSION) !== 0) {
    if (rest.length < 2) {
      throw new ProtocolError(`frame: 会话槽缺少长度`);
    }
    const sessionLen = ((rest[0] ?? 0) << 8) | (rest[1] ?? 0);
    if (rest.length < 2 + sessionLen) {
      throw new ProtocolError(`frame: 会话槽截断`);
    }
    session = decodeUtf8(rest.subarray(2, 2 + sessionLen));
    rest = rest.subarray(2 + sessionLen);
  }
  if ((flags & FLAG_REQUEST_ID) !== 0) {
    if (rest.length < 2) {
      throw new ProtocolError(`frame: 请求幂等键缺少长度`);
    }
    const idLen = ((rest[0] ?? 0) << 8) | (rest[1] ?? 0);
    if (rest.length < 2 + idLen) {
      throw new ProtocolError(`frame: 请求幂等键截断`);
    }
    requestID = decodeUtf8(rest.subarray(2, 2 + idLen));
    rest = rest.subarray(2 + idLen);
  }
  return { operation: decodeUtf8(opBytes), session, requestID, payload: rest };
}
