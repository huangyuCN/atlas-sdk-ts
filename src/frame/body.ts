// 帧 body 构造与解析：[opLen:u16 大端][operation utf-8][payload]。
// 与服务端 transport/internal/client.BuildRawBody 格式一致。
// UTF-8 编解码走协议层自带实现（引擎宿主兼容加固——不依赖宿主 TextEncoder/TextDecoder）。
import { MAX_OPERATION_LEN } from './constants.js';
import { ProtocolError } from './protocolError.js';
import { decodeUtf8, encodeUtf8 } from './utf8.js';

/** 封装帧 body（与 Go frame.BuildRequestBody 对称）。
 * operation 空/超上限抛普通 Error——构造侧参数问题，非协议解析错误（与 Go 一致：
 * 服务端对超长 operation 回 ProtocolError 不断连，客户端构造侧校验提前拦）。 */
export function buildRequestBody(operation: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const opBytes = encodeUtf8(operation);
  if (opBytes.length === 0) {
    throw new Error('frame: operation 不能为空');
  }
  if (opBytes.length > MAX_OPERATION_LEN) {
    throw new Error(`frame: operation 长度 ${opBytes.length} 超过上限 ${MAX_OPERATION_LEN}`);
  }
  const body = new Uint8Array(2 + opBytes.length + payload.length);
  body[0] = opBytes.length >> 8;
  body[1] = opBytes.length & 0xff;
  body.set(opBytes, 2);
  body.set(payload, 2 + opBytes.length);
  return body;
}

/** 解析帧 body，返回 operation 与 payload（与 Go frame.ParseRequestBody 对称）。
 * opLen 超上限/operation 截断均为协议非法（ProtocolError）。 */
export function parseRequestBody(body: Uint8Array): { operation: string; payload: Uint8Array } {
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
  return {
    operation: decodeUtf8(opBytes),
    payload: body.subarray(2 + opLen),
  };
}
