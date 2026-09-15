// 帧头校验与头编解码（大端 16B：magic(4) ver(1) type(1) flags(1) rsv(1) seq(4) bodyLen(4)）。
import { getU32BE, putU32BE } from './bytes.js';
import {
  FLAG_RESERVED_MASK,
  HEADER_SIZE,
  MAGIC,
  MAX_BODY_SIZE,
  VERSION,
  VERSION_2,
  type Header,
  type MsgType,
} from './constants.js';
import { ProtocolError } from './protocolError.js';

/** 校验帧头合法性；maxBodySize ≤ 0 时回退绝对上限（与 Go Header.Check 同构）。 */
export function checkHeader(h: Header, maxBodySize: number): void {
  const max = maxBodySize > 0 ? maxBodySize : MAX_BODY_SIZE;
  if (h.magic !== MAGIC) {
    throw new ProtocolError(`frame: invalid magic: ${h.magic.toString(16)}`);
  }
  if (h.seq === 0) {
    throw new ProtocolError(`frame: invalid seq: 0`);
  }
  if (h.type !== 1 && h.type !== 2 && h.type !== 3) {
    throw new ProtocolError(`frame: invalid type: ${h.type}`);
  }
  // 版本白名单：ver=1（protojson）/ ver=2（protobuf 二进制）；其余拒绝（前向
  // 版本协商位留给未来扩展，未知版本即协议非法；与 Go Header.Check 同构）。
  if (h.version !== VERSION && h.version !== VERSION_2) {
    throw new ProtocolError(`frame: invalid version: ${h.version}`);
  }
  // flags 位图校验：未知位（bit1–7）即协议非法（与 Go Header.Check 同构）。
  if (((h.flags ?? 0) & FLAG_RESERVED_MASK) !== 0) {
    throw new ProtocolError(`frame: invalid flags: ${h.flags}`);
  }
  if (h.length > max) {
    throw new ProtocolError(`frame: body too large: ${h.length} > ${max}`);
  }
}

/** 将 header 编码进 buf（buf 长度必须为 16；encodeFrame 与流式写共用）。
 * flags 写入 buf[6]（原 rsv 首字节），rsv 次字节恒为 0。 */
export function encodeHeaderInto(buf: Uint8Array, h: Header): void {
  putU32BE(buf, 0, h.magic);
  buf[4] = h.version;
  buf[5] = h.type;
  buf[6] = h.flags ?? 0;
  putU32BE(buf, 8, h.seq);
  putU32BE(buf, 12, h.length);
}

/** 从 msg 头部解析 16B 帧（不校验——校验由调用方 checkHeader 统一执行）。 */
export function decodeHeaderAt(msg: Uint8Array): Header {
  return {
    magic: getU32BE(msg, 0),
    version: msg[4] ?? 0,
    type: (msg[5] ?? 0) as MsgType,
    flags: msg[6] ?? 0,
    seq: getU32BE(msg, 8),
    length: getU32BE(msg, 12),
  };
}

export { HEADER_SIZE };
