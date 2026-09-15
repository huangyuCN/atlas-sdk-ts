// 帧 body 构造与解析单元测试（[opLen:u16][operation utf-8][payload]；flags 置位
// FLAG_SESSION 时的带会话槽布局）。
import { describe, expect, it } from 'vitest';
import {
  FLAG_SESSION,
  MAX_OPERATION_LEN,
  MAX_SESSION_LEN,
  ProtocolError,
  buildRequestBody,
  buildRequestBodyWithSession,
  parseRequestBody,
  parseRequestBodyWithSession,
} from '../src/frame/index.js';
import { bytesOf, concat } from './helpers.js';

describe('buildRequestBody', () => {
  it('构造 opLen+operation+payload（大端 u16 opLen）', () => {
    const body = buildRequestBody('/atlas.internal.Heartbeat/Ping', bytesOf('{}'));
    expect(body.length).toBe(2 + 30 + 2);
    expect(body[0]).toBe(0); // opLen 高字节（30 < 256）
    expect(body[1]).toBe(30);
    expect(body.subarray(2, 32)).toEqual(bytesOf('/atlas.internal.Heartbeat/Ping'));
    expect(body.subarray(32)).toEqual(bytesOf('{}'));
  });

  it('空 payload 合法', () => {
    const body = buildRequestBody('op', new Uint8Array(0));
    expect(body.length).toBe(4);
  });

  it('operation 为空抛普通错误（构造侧，非协议解析错误）', () => {
    expect(() => buildRequestBody('', new Uint8Array(0))).toThrow(/不能为空/);
  });

  it('operation 超过 4096 抛普通错误', () => {
    const long = 'a'.repeat(MAX_OPERATION_LEN + 1);
    expect(() => buildRequestBody(long, new Uint8Array(0))).toThrow(/超过上限/);
  });
});

describe('parseRequestBody', () => {
  it('往返：operation 与 payload 解出', () => {
    const payload = bytesOf('{"frameId":"1"}');
    const body = buildRequestBody('/lockstep.v1.Session/OnFrame', payload);
    const parsed = parseRequestBody(body);
    expect(parsed.operation).toBe('/lockstep.v1.Session/OnFrame');
    expect(parsed.payload).toEqual(payload);
  });

  it('body 过短（缺 opLen）→ ProtocolError', () => {
    expect(() => parseRequestBody(new Uint8Array(1))).toThrow(ProtocolError);
    expect(() => parseRequestBody(new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('opLen 超上限 → ProtocolError', () => {
    const body = new Uint8Array(2);
    body[0] = 0x10; // opLen = 0x1001 = 4097（大端，超过上限 4096）
    body[1] = 0x01;
    expect(() => parseRequestBody(body)).toThrow(ProtocolError);
  });

  it('operation 截断 → ProtocolError', () => {
    const body = new Uint8Array(2 + 4);
    body[1] = 8; // opLen=8 但只有 4 字节 op
    expect(() => parseRequestBody(body)).toThrow(ProtocolError);
  });
});

describe('会话槽（flags 置位 FLAG_SESSION 的 body 布局）', () => {
  it('buildRequestBodyWithSession 布局：[opLen][op][sessionLen][session][payload]', () => {
    const payload = bytesOf('{}');
    const body = buildRequestBodyWithSession('/gateway.v1.Session/Login', 'tok-42', payload);
    const opBytes = bytesOf('/gateway.v1.Session/Login');
    const sessionBytes = bytesOf('tok-42');
    expect(body.length).toBe(2 + opBytes.length + 2 + sessionBytes.length + payload.length);
    expect(body.subarray(2, 2 + opBytes.length)).toEqual(opBytes);
    const off = 2 + opBytes.length;
    expect((body[off] ?? 0) << 8 | (body[off + 1] ?? 0)).toBe(sessionBytes.length);
    expect(body.subarray(off + 2, off + 2 + sessionBytes.length)).toEqual(sessionBytes);
    expect(body.subarray(off + 2 + sessionBytes.length)).toEqual(payload);
  });

  it('往返：parseRequestBodyWithSession 解出 operation/session/payload', () => {
    const payload = bytesOf('{"playerId":"42"}');
    const body = buildRequestBodyWithSession('/gateway.v1.Session/Resume', 'tok-abc', payload);
    const parsed = parseRequestBodyWithSession(body, FLAG_SESSION);
    expect(parsed.operation).toBe('/gateway.v1.Session/Resume');
    expect(parsed.session).toBe('tok-abc');
    expect(parsed.payload).toEqual(payload);
  });

  it('flags 未置位：session 为空、payload 即余下字节（旧布局不受影响）', () => {
    const body = buildRequestBody('/op', bytesOf('pp'));
    const parsed = parseRequestBodyWithSession(body, 0);
    expect(parsed.operation).toBe('/op');
    expect(parsed.session).toBe('');
    expect(parsed.payload).toEqual(bytesOf('pp'));
  });

  it('空会话与旧布局等价（匿名请求）', () => {
    const payload = bytesOf('{}');
    expect(buildRequestBodyWithSession('/op', '', payload)).toEqual(buildRequestBody('/op', payload));
  });

  it('会话槽缺少长度（flags 置位但 rest 为空）→ ProtocolError', () => {
    expect(() => parseRequestBodyWithSession(buildRequestBody('/op'), FLAG_SESSION)).toThrow(ProtocolError);
  });

  it('会话槽截断（长度声明大于实际剩余）→ ProtocolError', () => {
    const opBytes = bytesOf('/op');
    const body = concat(
      Uint8Array.of(0, opBytes.length),
      opBytes,
      Uint8Array.of(0, 8), // sessionLen=8
      bytesOf('tok'), // 实际只有 3 字节
    );
    expect(() => parseRequestBodyWithSession(body, FLAG_SESSION)).toThrow(ProtocolError);
  });

  it('session 超上限（256 字节）抛普通 Error（构造侧参数问题）', () => {
    const long = 's'.repeat(MAX_SESSION_LEN + 1);
    expect(() => buildRequestBodyWithSession('/op', long, new Uint8Array(0))).toThrow(/超过上限/);
    // 恰好 256 字节合法
    expect(() => buildRequestBodyWithSession('/op', 's'.repeat(MAX_SESSION_LEN), new Uint8Array(0))).not.toThrow();
  });

  it('parseRequestBody 不解析会话槽：flags 置位时仍按旧布局（Go ParseRequestBody 同构）', () => {
    const body = buildRequestBodyWithSession('/op', 'tok', bytesOf('p'));
    const parsed = parseRequestBody(body);
    expect(parsed.operation).toBe('/op');
    // 余下字节即 [sessionLen:2]['tok']['p']（不校验、不解出）
    expect(parsed.payload).toEqual(concat(Uint8Array.of(0, 3), bytesOf('tok'), bytesOf('p')));
  });
});
