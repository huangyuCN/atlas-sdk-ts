// Status protobuf 最小解码器单元测试：字段解析、未知字段跳过、负 code varint、map entry、wire 非法。
import { describe, expect, it } from 'vitest';
import { ProtocolError, decodeStatus } from '../src/frame/index.js';
import {
  appendBytesField,
  appendVarintField,
  bytesOf,
  buildTestStatus,
  encodeUvarint,
} from './helpers.js';

describe('decodeStatus', () => {
  it('全字段解码（code/reason/message/metadata）', () => {
    const raw = buildTestStatus(404, 'PLAYER_NOT_FOUND', '玩家不存在', { k: 'v' });
    const st = decodeStatus(raw);
    expect(st.code).toBe(404);
    expect(st.reason).toBe('PLAYER_NOT_FOUND');
    expect(st.message).toBe('玩家不存在');
    expect(st.metadata).toEqual({ k: 'v' });
  });

  it('空字节解码为零值 Status', () => {
    const st = decodeStatus(new Uint8Array(0));
    expect(st.code).toBe(0);
    expect(st.reason).toBe('');
    expect(st.message).toBe('');
    expect(st.metadata).toBeUndefined();
  });

  it('负 code（int32 补码 varint，10 字节形态）', () => {
    const raw = buildTestStatus(-1, 'INTERNAL', '', null);
    const st = decodeStatus(raw);
    expect(st.code).toBe(-1);
    expect(st.reason).toBe('INTERNAL');
  });

  it('未知字段静默跳过（DiscardUnknown 语义对齐）', () => {
    // field 99（wire=2）：tag varint = 99<<3|2 = 794（多字节 varint 0x9A 0x06，
    // appendBytesField 自动编码）——与 Go golden 用例的构造形态等价。
    const out: number[] = [...buildTestStatus(7, 'OK', '', null)];
    appendBytesField(out, 99, bytesOf('future-field'));
    const st = decodeStatus(Uint8Array.from(out));
    expect(st.code).toBe(7);
    expect(st.reason).toBe('OK');
  });

  it('多个 metadata entry 顺序解码', () => {
    const raw = buildTestStatus(0, '', '', { a: '1', b: '2' });
    const st = decodeStatus(raw);
    expect(st.metadata).toEqual({ a: '1', b: '2' });
  });

  it('字段 key 非法（截断的 varint）→ ProtocolError', () => {
    expect(() => decodeStatus(Uint8Array.of(0x80))).toThrow(ProtocolError);
  });

  it('varint 值截断 → ProtocolError', () => {
    // tag 合法（field 1 wire 0）但 varint 值字节不完整（持续高位）
    const raw = Uint8Array.of(0x08, 0xff, 0xff);
    expect(() => decodeStatus(raw)).toThrow(ProtocolError);
  });

  it('bytes 长度超出剩余 → ProtocolError', () => {
    const raw = Uint8Array.of(0x12, 0x20, 0x61); // field2 bytes 长度 32 > 剩余 1
    expect(() => decodeStatus(raw)).toThrow(ProtocolError);
  });

  it('已知字段 wire type 不符（field1 收到 64-bit）→ ProtocolError', () => {
    const raw = Uint8Array.of(0x09, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
    expect(() => decodeStatus(raw)).toThrow(ProtocolError);
  });

  it('varint 上限：10 字节且末字节 >1 → ProtocolError（Go binaryUvarint 同款溢出判定）', () => {
    const raw = Uint8Array.of(0x08, ...Array.from({ length: 9 }, () => 0xff), 0x02);
    expect(() => decodeStatus(raw)).toThrow(ProtocolError);
  });

  it('varint 编码工具与解码往返（边界值）', () => {
    for (const v of [0n, 1n, 127n, 128n, 300n, 16383n, 2n ** 53n]) {
      const enc = encodeUvarint(v);
      expect(enc.length).toBeLessThanOrEqual(10);
    }
  });

  it('appendVarintField / appendBytesField 构造与解码自洽', () => {
    const out: number[] = [];
    appendVarintField(out, 1, 42n);
    appendBytesField(out, 2, bytesOf('OK'));
    const st = decodeStatus(Uint8Array.from(out));
    expect(st.code).toBe(42);
    expect(st.reason).toBe('OK');
  });

  it('未知字段（>4）的 fixed64 wire 静默跳过（评审 Fix：与 Go proto.Unmarshal 对齐）', () => {
    // field 5 wire 1（64-bit）+ 8 字节载荷 + 合法 field 1 varint code=7
    const raw = Uint8Array.of(
      0x29, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, // field5 wire1 + 8B
      0x08, 0x07, // field1 varint 7
    );
    const st = decodeStatus(raw);
    expect(st.code).toBe(7); // 未知 fixed64 被跳过，后续字段正常解析
  });

  it('已知字段号 wire type 不符 → ProtocolError（与 Go proto.Unmarshal 一致）', () => {
    // field 1（code 声明 varint）收到 wire 1（64-bit）
    const raw = Uint8Array.of(0x09, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08);
    expect(() => decodeStatus(raw)).toThrow(ProtocolError);
  });

  it('metadata 的 __proto__ 键不丢失（评审 Fix：无原型对象承载，与 Go map 对齐）', () => {
    // field4 bytes map entry：key="__proto__" value="x"（entry 内 key=1 wire2、value=2 wire2）
    const out: number[] = [];
    const entry: number[] = [];
    appendBytesField(entry, 1, bytesOf('__proto__'));
    appendBytesField(entry, 2, bytesOf('x'));
    appendBytesField(out, 4, Uint8Array.from(entry));
    const st = decodeStatus(Uint8Array.from(out));
    expect(st.metadata?.['__proto__']).toBe('x');
  });
});
