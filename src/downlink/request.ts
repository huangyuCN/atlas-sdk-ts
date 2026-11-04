// 关键帧请求（RequestFrameKeyframe）的载荷编码：op 是游戏协议寻址键，载荷字段属游戏协议，
// 但 SDK 在解码失步时必须能**自己**发一次请求（否则「丢弃」就变成永久花屏）。
//
// 字段号与 battle.v1.RequestFrameKeyframeReq 一致：
//   string battle_id = 1; uint64 last_seq = 2;
// ver=1（protojson）按生成物语义发 `{"battleId":"...","lastSeq":"<uint64 字符串>"}`；
// ver=2（protobuf 二进制）按最小 wire 编码。只说「我实际拥有哪一帧」，不携带任何对局参数。
import { lengthDelimited, varintField } from './wire.js';

/** encodeKeyframeRequest 按会话载荷编码版本生成请求载荷字节。 */
export function encodeKeyframeRequest(battleId: string, lastSeq: number, version: number): Uint8Array {
  if (version === 1) {
    const json = JSON.stringify({ battleId, lastSeq: String(lastSeq) });
    return new TextEncoder().encode(json);
  }
  return new Uint8Array([
    ...lengthDelimited(1, new TextEncoder().encode(battleId)),
    ...varintField(2, BigInt(lastSeq)),
  ]);
}
