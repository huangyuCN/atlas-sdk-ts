// 响应包络解码单元测试：成功/失败形态、statusLen=0 容忍、截断、尾随字节忽略。
import { describe, expect, it } from 'vitest';
import { ProtocolError, decodeReply } from '../src/frame/index.js';
import { buildReplyErr, buildReplyOK, buildTestStatus, bytesOf, putU32BE } from './helpers.js';

describe('decodeReply', () => {
  it('成功包络：data 解出、status 为 null', () => {
    const data = bytesOf('{"playerId":"p1"}');
    const reply = decodeReply(buildReplyOK(data));
    expect(reply.status).toBeNull();
    expect(reply.data).toEqual(data);
  });

  it('失败包络：Status 解出 + data 保留', () => {
    const status = buildTestStatus(404, 'PLAYER_NOT_FOUND', '玩家不存在', null);
    const data = bytesOf('{"hint":"x"}');
    const reply = decodeReply(buildReplyErr(status, data));
    expect(reply.status?.code).toBe(404);
    expect(reply.status?.reason).toBe('PLAYER_NOT_FOUND');
    expect(reply.data).toEqual(data);
  });

  it('statusLen=0 是合法包络：容忍为零值 Status', () => {
    // 失败形态但 status 为空：[1][0][dataLen][data]
    const data = bytesOf('{}');
    const out = new Uint8Array(1 + 4 + 4 + data.length);
    out[0] = 1;
    putU32BE(out.subarray(1, 5), 0);
    putU32BE(out.subarray(5, 9), data.length);
    out.set(data, 9);
    const reply = decodeReply(out);
    expect(reply.status).not.toBeNull();
    expect(reply.status?.code).toBe(0);
    expect(reply.data).toEqual(data);
  });

  it('statusLen=0 且 dataLen=0', () => {
    const out = new Uint8Array(9);
    out[0] = 1;
    const reply = decodeReply(out);
    expect(reply.status?.code).toBe(0);
    expect(reply.data.length).toBe(0);
  });

  it('短于 5B → ProtocolError', () => {
    expect(() => decodeReply(new Uint8Array(4))).toThrow(ProtocolError);
  });

  it('data 截断 → ProtocolError', () => {
    const ok = buildReplyOK(bytesOf('abcd'));
    expect(() => decodeReply(ok.subarray(0, ok.length - 1))).toThrow(ProtocolError);
  });

  it('status 截断 → ProtocolError', () => {
    const status = buildTestStatus(404, 'PLAYER_NOT_FOUND', '', null);
    const env = buildReplyErr(status, new Uint8Array(0));
    expect(() => decodeReply(env.subarray(0, 5 + status.length - 1))).toThrow(ProtocolError);
  });

  it('尾随多余字节被忽略（只按 dataLen 取范围）', () => {
    const data = bytesOf('{"playerId":"p1"}');
    const padded = new Uint8Array(buildReplyOK(data).length + 3);
    padded.set(buildReplyOK(data), 0);
    const reply = decodeReply(padded);
    expect(reply.data).toEqual(data);
  });
});
