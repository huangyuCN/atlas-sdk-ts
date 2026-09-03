// 帧编解码单元测试：大端字节序、零值补默认、校验失败分支、消息边界失步、流式三态。
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_SIZE,
  MsgType,
  ProtocolError,
  decodeFrame,
  encodeFrame,
  readFrameFrom,
} from '../src/frame/index.js';
import { bytesOf, concat, concatFrame, putU32BE } from './helpers.js';

describe('encodeFrame', () => {
  it('头字段按大端逐字节落位（16B 头 + body）', () => {
    const body = bytesOf('hello');
    const out = encodeFrame(
      { magic: 0x41544c53, version: 1, type: MsgType.Request, seq: 0x01020304, length: 0 },
      body,
      0,
    );
    expect(out.length).toBe(16 + body.length);
    expect(out.subarray(0, 4)).toEqual(Uint8Array.of(0x41, 0x54, 0x4c, 0x53));
    expect(out[4]).toBe(1); // version
    expect(out[5]).toBe(1); // type=Request
    expect(out[6]).toBe(0); // rsv
    expect(out[7]).toBe(0); // rsv
    expect(out[8]).toBe(0x01); // seq 高字节
    expect(out[15]).toBe(5); // bodyLen 低字节（大端 00 00 00 05）
    expect(out.subarray(16)).toEqual(body);
  });

  it('magic/version 零值补协议默认值', () => {
    const out = encodeFrame(
      { magic: 0, version: 0, type: MsgType.Response, seq: 7, length: 0 },
      new Uint8Array(0),
      0,
    );
    expect(out[0]).toBe(0x41);
    expect(out[4]).toBe(1);
    expect(out[12]).toBe(0);
  });

  it('body 超过上限抛 ProtocolError', () => {
    const big = new Uint8Array(MAX_BODY_SIZE + 1);
    expect(() => encodeFrame(
      { magic: 0x41544c53, version: 1, type: MsgType.Request, seq: 1, length: 0 },
      big,
      0,
    )).toThrow(ProtocolError);
  });

  it('自定义上限生效', () => {
    const body = new Uint8Array(65);
    expect(() => encodeFrame(
      { magic: 0x41544c53, version: 1, type: MsgType.Request, seq: 1, length: 0 },
      body,
      64,
    )).toThrow(ProtocolError);
  });
});

describe('decodeFrame（消息边界）', () => {
  it('合法帧往返：头 + body 子数组', () => {
    const body = bytesOf('{"playerId":"p1"}');
    const msg = concatFrame(MsgType.Notify, 42, body);
    const { header, body: got } = decodeFrame(msg, 0);
    expect(header.type).toBe(MsgType.Notify);
    expect(header.seq).toBe(42);
    expect(header.length).toBe(body.length);
    expect(got).toEqual(body);
  });

  it('bodyLen=0 的空 body 帧往返', () => {
    const msg = concatFrame(MsgType.Request, 1, new Uint8Array(0));
    const { body } = decodeFrame(msg, 0);
    expect(body.length).toBe(0);
  });

  it('短于帧头 → ProtocolError（消息边界下即失步）', () => {
    expect(() => decodeFrame(new Uint8Array(15), 0)).toThrow(ProtocolError);
  });

  it('消息长度与 bodyLen 不一致 → ProtocolError', () => {
    const msg = concatFrame(MsgType.Request, 1, bytesOf('abc'));
    expect(() => decodeFrame(msg.subarray(0, msg.length - 1), 0)).toThrow(ProtocolError);
    expect(() => decodeFrame(concat(msg, Uint8Array.of(0x00)), 0)).toThrow(ProtocolError);
  });

  it('头校验失败分支：bad magic / type / version / seq=0 / 超限', () => {
    const base = concatFrame(MsgType.Request, 1, bytesOf('x'));
    const badMagic = base.subarray();
    badMagic[0] = 0x00;
    expect(() => decodeFrame(badMagic, 0)).toThrow(ProtocolError);

    const badType = concatFrame(MsgType.Request, 1, bytesOf('x'));
    badType[5] = 0;
    expect(() => decodeFrame(badType, 0)).toThrow(ProtocolError);

    const badVersion = concatFrame(MsgType.Request, 1, bytesOf('x'));
    badVersion[4] = 99;
    expect(() => decodeFrame(badVersion, 0)).toThrow(ProtocolError);

    const badSeq = concatFrame(MsgType.Request, 0, bytesOf('x'));
    expect(() => decodeFrame(badSeq, 0)).toThrow(ProtocolError);

    const oversize = new Uint8Array(16);
    putU32BE(oversize.subarray(0, 4), 0x41544c53);
    oversize[4] = 1;
    oversize[5] = 1;
    putU32BE(oversize.subarray(8, 12), 1);
    putU32BE(oversize.subarray(12, 16), 3);
    expect(() => decodeFrame(concat(oversize, bytesOf('abc')), 2)).toThrow(ProtocolError);
  });
});

describe('readFrameFrom（流式语义，Go frame.Read 同构三态）', () => {
  it('完整缓冲读出一帧（consumed 覆盖头+body）', () => {
    const body = bytesOf('ping');
    const buf = concat(concatFrame(MsgType.Request, 9, body), bytesOf('trailing'));
    const res = readFrameFrom(buf, 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.header.seq).toBe(9);
      expect(res.body).toEqual(body);
      expect(res.consumed).toBe(16 + body.length);
    }
  });

  it('头不完整 → incomplete（对应 io.EOF/UnexpectedEOF，golden 对拍归 network）', () => {
    const res = readFrameFrom(concatFrame(MsgType.Request, 1, bytesOf('x')).subarray(0, 10), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('incomplete');
  });

  it('body 不完整 → incomplete', () => {
    const full = concatFrame(MsgType.Request, 1, bytesOf('abcdef'));
    const res = readFrameFrom(full.subarray(0, full.length - 2), 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('incomplete');
  });

  it('头校验失败 → protocol', () => {
    const bad = concatFrame(MsgType.Request, 1, bytesOf('x'));
    bad[0] = 0;
    const res = readFrameFrom(bad, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('protocol');
  });

  it('bodyLen 高位为 1 的 uint32 按无符号处理（评审 Blocker：0xffffffff 不得绕过上限）', () => {
    // 手工构造 16B 头：magic/version/type/seq 合法，bodyLen=0xffffffff
    const buf = new Uint8Array(16);
    putU32BE(buf.subarray(0, 4), 0x41544c53);
    buf[4] = 1; // version
    buf[5] = 1; // type=Request
    putU32BE(buf.subarray(8, 12), 7); // seq
    putU32BE(buf.subarray(12, 16), 0xffffffff); // bodyLen（高位为 1）
    const res = readFrameFrom(buf, 0);
    // 0xffffffff > MAX_BODY_SIZE：必须 protocol，不得因有符号负数绕过上限检查
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('protocol');
  });

  it('seq 高位为 1 的 uint32 保持无符号（评审 Blocker：与 Go uint32 对齐）', () => {
    const body = bytesOf('x');
    const buf = concatFrame(MsgType.Request, 7, body);
    putU32BE(buf.subarray(8, 12), 0x80000001); // seq 高位为 1
    const res = readFrameFrom(buf, 0);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.header.seq).toBe(0x80000001);
  });
});
