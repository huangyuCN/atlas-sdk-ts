// 下行增量（ver=3）的 wire 层：最小 protobuf 读写器。
//
// 为什么 SDK 里要有一份 wire 读写：合并必须在**字节层**完成——SDK 不持有游戏域 DTO
//（见 test/gameDomainGuard.test.ts），而 ver=3 的恢复语义是「把增量并进基线、仍按
// FrameBroadcast 全量字节交给上层」。这里只认本协议用到的字段号与线型，不引游戏协议包。
//
// 编码口径与 Go 的 proto.Marshal **逐字节对齐**（同一批 golden 向量是唯一裁判）：
//   - 字段按字段号升序；proto3 默认值（0 / 空串 / 空 bytes）省略；
//   - 长度分隔型：tag + varint(len) + 原始字节；varint 用 64 位补码（int64 负值同口径）。
import { ProtocolError } from '../client/errors.js';

/** WireField 一条已解码的 wire 字段（wire 0 = varint，wire 2 = 长度分隔）。 */
export interface WireField {
  no: number;
  /** 线型（0 varint / 1 fixed64 / 2 长度分隔 / 5 fixed32）。 */
  wire: number;
  /** wire=0 时为 bigint，其余为原始字节（fixed 型保留 4/8 字节）。 */
  value: bigint | Uint8Array;
}

/** DownlinkError 增量载荷非法（与「失步丢弃」区分：这是载荷本身解不开）。 */
export class DownlinkError extends ProtocolError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'DownlinkError';
  }
}

/** asBytes 取长度分隔字段的字节（类型收窄；调用方保证 wire=2）。 */
export function asBytes(f: WireField): Uint8Array {
  return f.value as Uint8Array;
}

/** varint 编码一个 64 位无符号值（负数由调用方先 asUintN(64)）。 */
export function varint(v: bigint): Uint8Array {
  if (v < 0n) throw new DownlinkError(`varint 不接受负值：${v}`);
  const out: number[] = [];
  let n = v;
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return Uint8Array.from(out);
}

/** tag 编码字段号与线型。 */
export function tag(no: number, wire: number): Uint8Array {
  return varint((BigInt(no) << 3n) | BigInt(wire));
}

/** concat 拼接若干字节块（跳过空块）。 */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** lengthDelimited 编码一条长度分隔字段；空 bytes 按 proto3 语义省略（返回空块）。 */
export function lengthDelimited(no: number, bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return new Uint8Array(0);
  return concat([tag(no, 2), varint(BigInt(bytes.length)), bytes]);
}

/** varintField 编码一条 varint 字段；0 按 proto3 语义省略。 */
export function varintField(no: number, v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  return concat([tag(no, 0), varint(v)]);
}

/** parseFields 解析一个 protobuf 消息为字段列表（保留出现顺序，容忍未知字段号）。 */
export function parseFields(buf: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let off = 0;
  while (off < buf.length) {
    const t = readVarint(buf, off);
    off = t.next;
    const no = Number(t.value >> 3n);
    const wire = Number(t.value & 7n);
    if (no === 0) throw new DownlinkError('protobuf: 字段号为 0');
    if (wire === 0) {
      const v = readVarint(buf, off);
      off = v.next;
      fields.push({ no, wire, value: v.value });
    } else if (wire === 1) {
      if (off + 8 > buf.length) throw new DownlinkError('protobuf: fixed64 截断');
      fields.push({ no, wire, value: buf.subarray(off, off + 8) });
      off += 8;
    } else if (wire === 2) {
      const l = readVarint(buf, off);
      off = l.next;
      const len = Number(l.value);
      if (len < 0 || off + len > buf.length) throw new DownlinkError('protobuf: 长度分隔截断');
      fields.push({ no, wire, value: buf.subarray(off, off + len) });
      off += len;
    } else if (wire === 5) {
      if (off + 4 > buf.length) throw new DownlinkError('protobuf: fixed32 截断');
      fields.push({ no, wire, value: buf.subarray(off, off + 4) });
      off += 4;
    } else {
      throw new DownlinkError(`protobuf: 不支持的线型 ${wire}`);
    }
  }
  return fields;
}

/** readVarint 从 off 读一个 varint（最多 10 字节）。 */
export function readVarint(buf: Uint8Array, off: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = off;
  for (let n = 0; n < 10; n++) {
    if (i >= buf.length) throw new DownlinkError('protobuf: varint 截断');
    const b = buf[i++] as number;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
  }
  throw new DownlinkError('protobuf: varint 超长');
}

/** encodeField 按已解码字段重新编码（用于「改写 frame_id 后原样保留其余字段」）。 */
export function encodeField(f: WireField): Uint8Array {
  if (f.wire === 0) return concat([tag(f.no, 0), varint(f.value as bigint)]);
  if (f.wire === 2) return concat([tag(f.no, 2), varint(BigInt(asBytes(f).length)), asBytes(f)]);
  return concat([tag(f.no, f.wire), f.value as Uint8Array]);
}

/** firstBytes 取指定字段号的第一条长度分隔值（不存在返回 null）。 */
export function firstBytes(fields: readonly WireField[], no: number): Uint8Array | null {
  for (const f of fields) {
    if (f.no === no && f.wire === 2) return asBytes(f);
  }
  return null;
}

/** allBytes 取指定字段号的全部长度分隔值（保持出现顺序）。 */
export function allBytes(fields: readonly WireField[], no: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const f of fields) {
    if (f.no === no && f.wire === 2) out.push(asBytes(f));
  }
  return out;
}

/** firstVarint 取指定字段号的第一条 varint（不存在返回 0n）。 */
export function firstVarint(fields: readonly WireField[], no: number): bigint {
  for (const f of fields) {
    if (f.no === no && f.wire === 0) return f.value as bigint;
  }
  return 0n;
}

/** toNumber 把帧号从 64 位收窄为 number（超出安全整数即报错，绝不静默截断）。 */
export function toNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new DownlinkError(`帧号超出安全整数：${v}`);
  return Number(v);
}
