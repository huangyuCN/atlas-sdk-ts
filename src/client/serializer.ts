// 序列化插槽（规范 §3.1：serializer 是内核插槽，当前为 protojson 兼容 JSON，
// 将来可切换二进制实现而内核不动）。请求对象 → payload 字节；响应 payload 字节 →
// 调用方填充的目标对象。
import { ProtocolError } from './errors.js';
import { decodeUtf8, encodeUtf8 } from '../frame/utf8.js';

/** 序列化器接口：与 Go 侧 Serializer 同构。 */
export interface Serializer {
  readonly name: string;
  /** 请求对象 → payload 字节。 */
  marshal(req: unknown): Uint8Array;
  /** payload 字节 → 填充目标对象（resp 为 null 表示仅解码返回，调用方自取）。 */
  unmarshal(payload: Uint8Array, resp: unknown): unknown;
}

/** 默认 JSON 序列化器（protojson 风格：字段 camelCase、64 位整数按字符串）。 */
export class JsonSerializer implements Serializer {
  readonly name = 'json';

  marshal(req: unknown): Uint8Array {
    if (req === undefined || req === null) return new Uint8Array(0);
    try {
      return encodeUtf8(JSON.stringify(req));
    } catch (err) {
      throw new ProtocolError('请求序列化失败', err);
    }
  }

  unmarshal(payload: Uint8Array, resp: unknown): unknown {
    if (payload.length === 0) return resp;
    let value: unknown;
    try {
      value = JSON.parse(decodeUtf8(payload));
    } catch (err) {
      throw new ProtocolError('响应反序列化失败', err);
    }
    if (resp !== null && resp !== undefined && isObject(value) && isObject(resp)) {
      Object.assign(resp, value);
      return resp;
    }
    return value;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 默认序列化器实例（各 Client/通道共享；无状态可共享）。 */
export const defaultSerializer: Serializer = new JsonSerializer();
