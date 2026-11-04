// 帧头载荷版本白名单的验收用例（与框架仓 transport/frame/gen/goframe/payload_versions_test.go、
// C# 端 FramePayloadVersionsTest 三端同名对称）：
//
//   ① ver=3（下行增量广播）必须能解出帧头与 body——旧白名单只认 ver=1/2 时这里是真红；
//   ② 未定义的 ver=4 仍必须被拒（扩白名单 ≠ 放开一切）；
//   ③ 「能声明的版本集合 == 解码器接受的版本集合」逐版本对账（防两处独立维护再漂移）。
import { describe, expect, it } from 'vitest';
import { checkHeader, decode } from '../src/frame/gen/codec.js';
import {
  HEADER_SIZE,
  MSG_TYPE_REQUEST,
  PAYLOAD_VERSIONS,
} from '../src/frame/gen/consts.js';

/** literalFrame 用线格式字面量拼一帧（magic(4)|version(1)|type(1)|flags(1)|pad(1)|seq(4)|length(4)+body）。
 * 不用 encode 自拼自解：期望值必须是字面量，否则「生成物证明生成物」是恒等式。 */
function literalFrame(version: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + body.length);
  out.set([0x41, 0x54, 0x4c, 0x53], 0); // "ATLS"
  out[4] = version;
  out[5] = MSG_TYPE_REQUEST;
  out[6] = 0; // flags
  out[7] = 0; // 保留位
  out[11] = 1; // seq = 1（大端）
  const len = body.length;
  out[12] = (len >>> 24) & 0xff;
  out[13] = (len >>> 16) & 0xff;
  out[14] = (len >>> 8) & 0xff;
  out[15] = len & 0xff;
  out.set(body, HEADER_SIZE);
  return out;
}

/** acceptedVersions 探测解码器真正接受的版本集合（0..255 全量扫，不信任任何声明）。 */
function acceptedVersions(): number[] {
  const accepted: number[] = [];
  for (let v = 0; v < 256; v += 1) {
    const h = { magic: 0x41544c53, version: v, type: MSG_TYPE_REQUEST, flags: 0, seq: 1, length: 0 };
    try {
      checkHeader(h, 0);
      accepted.push(v);
    } catch {
      // 被拒：不属于接受集合
    }
  }
  return accepted;
}

describe('帧头载荷版本白名单', () => {
  it('ver=3 增量帧能解出帧头与 body（不再 invalid version）', () => {
    const body = new TextEncoder().encode('delta');
    const { header, body: got } = decode(literalFrame(3, body), 0);
    expect(header.version).toBe(3);
    expect(new TextDecoder().decode(got)).toBe('delta');
  });

  it('未定义的 ver=4 仍被拒（错误文本指名非法版本）', () => {
    expect(() => decode(literalFrame(4, new Uint8Array(0)), 0)).toThrow(/invalid version: 4/);
  });

  it('能声明的版本集合 == 解码器接受的版本集合（防漂移）', () => {
    const declared = [...PAYLOAD_VERSIONS];
    expect(declared).toContain(3);
    expect(new Set(declared).size).toBe(declared.length); // 无重复
    expect(acceptedVersions()).toEqual(declared);
  });
});
