// atlas errors.Status 的客户端侧还原：手写 protobuf wire 解码（字段号见
// atlas errors/errors.proto：code=1 int32 varint、reason=2 string、message=3 string、
// metadata=4 map<string,string>，每个 entry 为嵌套 message：key=1、value=2）。
// 手写解码避免引入完整 protobuf 运行时（规范 §3.1：错误 Status 是唯一例外）。
// 字段字符串的 UTF-8 解码走协议层自带实现（引擎宿主兼容加固，严格模式）。
import { ProtocolError } from './protocolError.js';
import { decodeUtf8 } from './utf8.js';
import { readUvarint } from './varint.js';

/** Status 客户端侧表示。metadata 无字段时为 undefined（对应 Go nil map / 期望 JSON null）。 */
export interface Status {
  code: number;
  reason: string;
  message: string;
  metadata?: Record<string, string>;
}

// protobuf wire types（本解码器仅需 varint(0) 与 length-delimited(2)；其余报协议错误）。
const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

/** 解析 Status（未知字段静默跳过，与规范 §6.2 DiscardUnknown 语义对齐）。
 * wire 格式非法（varint 截断/溢出、长度越界、不支持的 wire type）抛 ProtocolError。 */
export function decodeStatus(b: Uint8Array): Status {
  const st: Status = { code: 0, reason: '', message: '' };
  // metadata 用无原型对象承载（评审 Fix：普通对象的 __proto__ 键会被原型链
  // 拦截丢失，与 Go map[string]string 语义不符——恶意/特殊 key 不得丢失）。
  const meta: Record<string, string> = Object.create(null) as Record<string, string>;
  let hasMeta = false;
  walkFields(b, (fieldNum, wire, val, num) => {
    // 已知字段号（1-4）：wire type 必须与声明匹配（与 Go proto.Unmarshal 一致，
    // 字段号匹配但 wire 不符报错）；未知字段号（>4）：任意合法 wire 静默跳过。
    if (fieldNum === 1) {
      if (wire !== WIRE_VARINT) throw new ProtocolError(`frame: Status code 字段 wire type ${wire} 与声明不符`);
      // int32 语义：取低 32 位有符号解释（Go int32(num) 截断同构，如 -1 的补码 varint）。
      st.code = Number(BigInt.asIntN(32, num));
      return;
    }
    if (fieldNum === 2) {
      if (wire !== WIRE_BYTES) throw new ProtocolError(`frame: Status reason 字段 wire type ${wire} 与声明不符`);
      st.reason = decodeUtf8(val);
      return;
    }
    if (fieldNum === 3) {
      if (wire !== WIRE_BYTES) throw new ProtocolError(`frame: Status message 字段 wire type ${wire} 与声明不符`);
      st.message = decodeUtf8(val);
      return;
    }
    if (fieldNum === 4) {
      if (wire !== WIRE_BYTES) throw new ProtocolError(`frame: Status metadata 字段 wire type ${wire} 与声明不符`);
      const entry = decodeMapEntry(val);
      hasMeta = true;
      meta[entry[0]] = entry[1];
      return;
    }
    // 其他字段号：静默跳过（含 fixed32/fixed64 等任意合法 wire type）。
  });
  if (hasMeta) st.metadata = meta;
  return st;
}

type FieldVisitor = (fieldNum: number, wire: number, val: Uint8Array, num: bigint) => void;

// protobuf wire types（完整支持：varint=0、64-bit=1、length-delimited=2、
// start-group=3、end-group=4、32-bit=5）。未知字段的任意合法 wire type 均须
// 正确推进偏移后跳过（与 Go proto.Unmarshal 语义一致；评审缺陷：此前仅支持
// varint/bytes，未知字段用 fixed32/fixed64 wire 时误报协议错误）。
const WIRE_I64 = 1;
const WIRE_SGROUP = 3;
const WIRE_EGROUP = 4;
const WIRE_I32 = 5;

/** 遍历 protobuf message 的顶层字段（完整 wire type 支持）。
 * 各组 wire 读/跳过并正确推进 offset；group 类型按递归深度配对跳过。
 * 非法结构（varint 截断/溢出、长度越界、group 不配对）抛 ProtocolError。 */
function walkFields(b: Uint8Array, fn: FieldVisitor): void {
  let off = 0;
  while (off < b.length) {
    off = walkOne(b, off, fn, 0);
  }
}

// walkOne 处理单个字段：返回下一个字段的起始偏移。depth 为 group 嵌套深度
// （end-group 在 depth=0 时属非法结构——消息顶层不应有孤立 end-group）。
function walkOne(b: Uint8Array, off: number, fn: FieldVisitor, depth: number): number {
  const key = readUvarint(b, off);
  if (!('value' in key)) throw new ProtocolError('frame: Status 字段 key 非法');
  off += key.consumed;
  const fieldNum = Number(key.value >> 3n);
  const wire = Number(key.value & 0x7n);
  switch (wire) {
    case WIRE_VARINT: {
      const num = readUvarint(b, off);
      if (!('value' in num)) {
        throw new ProtocolError(`frame: field ${fieldNum} varint 非法`);
      }
      off += num.consumed;
      fn(fieldNum, wire, new Uint8Array(0), num.value);
      return off;
    }
    case WIRE_I64: {
      if (b.length - off < 8) throw new ProtocolError(`frame: field ${fieldNum} 64-bit 越界`);
      fn(fieldNum, wire, b.subarray(off, off + 8), 0n);
      return off + 8;
    }
    case WIRE_BYTES: {
      const len = readUvarint(b, off);
      if (!('value' in len)) {
        throw new ProtocolError(`frame: field ${fieldNum} bytes 长度非法`);
      }
      off += len.consumed;
      if (b.length - off < Number(len.value)) {
        throw new ProtocolError(`frame: field ${fieldNum} bytes 长度越界`);
      }
      fn(fieldNum, wire, b.subarray(off, off + Number(len.value)), 0n);
      return off + Number(len.value);
    }
    case WIRE_SGROUP: {
      // 嵌套 group：递归直至配对 end-group（未知字段跳过，不调用 fn）。
      let o = off;
      for (;;) {
        o = walkOne(b, o, fn, depth + 1);
        const k2 = readUvarint(b, o);
        if (!('value' in k2)) throw new ProtocolError('frame: Status 字段 key 非法');
        if (Number(k2.value & 0x7n) === WIRE_EGROUP) {
          return o + k2.consumed;
        }
        o += k2.consumed;
      }
    }
    case WIRE_EGROUP:
      // 顶层孤立 end-group：非法。
      throw new ProtocolError(`frame: field ${fieldNum} 孤立 end-group`);
    case WIRE_I32: {
      if (b.length - off < 4) throw new ProtocolError(`frame: field ${fieldNum} 32-bit 越界`);
      fn(fieldNum, wire, b.subarray(off, off + 4), 0n);
      return off + 4;
    }
    default:
      throw new ProtocolError(`frame: field ${fieldNum} 不支持的 wire type ${wire}`);
  }
}

/** 解析 map<string,string> 的 entry（key=1、value=2）。 */
function decodeMapEntry(b: Uint8Array): [string, string] {
  let k = '';
  let v = '';
  walkFields(b, (fieldNum, wire, val) => {
    if (fieldNum === 1 && wire === WIRE_BYTES) k = decodeUtf8(val);
    if (fieldNum === 2 && wire === WIRE_BYTES) v = decodeUtf8(val);
  });
  return [k, v];
}
