// 协议层 benchmark（热路径基线）：帧编解码与包络解码。
// 运行：pnpm vitest bench（结果按 docs/superpowers/benchmarks README 约定归档前先与用户确认）。
import { bench, describe } from 'vitest';
import {
  buildRequestBody,
  decodeFrame,
  decodeReply,
  decodeStatus,
  encodeFrame,
  MsgType,
} from '../src/frame/index.js';
import { buildTestStatus, bytesOf } from './helpers.js';

const body = buildRequestBody('/lockstep.v1.Session/OnFrame', bytesOf('{"frameId":"123456789012345","winner":"","scores":0}'));
const frame = encodeFrame(
  { magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 },
  body,
);
const replyPayload = bytesOf('{"playerId":"p1","gold":100}');
const replyBytes = (() => {
  const status = buildTestStatus(404, 'PLAYER_NOT_FOUND', '玩家不存在', { k: 'v' });
  const out = new Uint8Array(1 + 4 + status.length + 4 + replyPayload.length);
  out[0] = 1;
  out[1] = status.length >> 24;
  out[2] = (status.length >> 16) & 0xff;
  out[3] = (status.length >> 8) & 0xff;
  out[4] = status.length & 0xff;
  out.set(status, 5);
  const off = 5 + status.length;
  out[off] = replyPayload.length >> 24;
  out[off + 1] = (replyPayload.length >> 16) & 0xff;
  out[off + 2] = (replyPayload.length >> 8) & 0xff;
  out[off + 3] = replyPayload.length & 0xff;
  out.set(replyPayload, off + 4);
  return out;
})();

describe('协议层编解码', () => {
  bench('encodeFrame（约 5KB 帧）', () => {
    encodeFrame({ magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 }, body);
  });

  bench('decodeFrame（约 5KB 帧）', () => {
    decodeFrame(frame);
  });

  bench('decodeReply（失败包络 + Status + data）', () => {
    decodeReply(replyBytes);
  });

  bench('decodeStatus（含 metadata map）', () => {
    decodeStatus(buildTestStatus(404, 'PLAYER_NOT_FOUND', '玩家不存在', { k: 'v' }));
  });
});
