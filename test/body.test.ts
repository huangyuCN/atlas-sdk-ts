// 帧 body 构造与解析单元测试（[opLen:u16][operation utf-8][payload]）。
import { describe, expect, it } from 'vitest';
import { MAX_OPERATION_LEN, ProtocolError, buildRequestBody, parseRequestBody } from '../src/frame/index.js';
import { bytesOf } from './helpers.js';

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
