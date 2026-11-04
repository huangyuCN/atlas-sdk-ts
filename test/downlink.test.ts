// ver=3 下行增量解码的验收用例：跨语言 golden（与 Go 生成器同一批字节）+ 失步语义。
//
// 夹具 test/fixtures/delta-golden.json 由模板仓 lib/downlink 的
// TestGenerateGoldenVectors 生成（同一份文件原样复制到 C# 测试）：base + 7 步增量，
// 每步给出 delta 字节与该 tick 的**独立全量编码**。三端解出来必须逐字节相等。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DownlinkDecoder,
  DownlinkError,
  mergeDelta,
  parseDelta,
  readFrameId,
} from '../src/index.js';

/** GoldenStep 夹具里的一条增量。 */
interface GoldenStep {
  seq: number;
  baseSeq: number;
  delta: string;
  merged: string;
  note: string;
}

/** GoldenFile 夹具形态。 */
interface GoldenFile {
  source: string;
  base: string;
  steps: GoldenStep[];
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/delta-golden.json', import.meta.url), 'utf8'),
) as GoldenFile;

/** hex 解字节。 */
function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** toHex 字节转十六进制（对比口径）。 */
function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/** newDecoder 构造带请求计数的解码器。 */
function newDecoder(): { dec: DownlinkDecoder; requests: number[] } {
  const requests: number[] = [];
  const dec = new DownlinkDecoder((lastSeq) => requests.push(lastSeq));
  return { dec, requests };
}

describe('ver=3 增量合并（跨语言 golden，Go 生成）', () => {
  it('夹具完整：7 步、每步 seq = 上一步 + 1', () => {
    expect(golden.steps).toHaveLength(7);
    expect(golden.steps.map((s) => s.seq)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    for (const s of golden.steps) expect(s.baseSeq).toBe(s.seq - 1);
  });

  it('纯合并：mergeDelta 逐字节等于同一 tick 的全量编码', () => {
    let base = bytes(golden.base);
    for (const step of golden.steps) {
      const merged = mergeDelta(base, parseDelta(bytes(step.delta)));
      expect(toHex(merged), `第 ${step.seq} 帧：${step.note}`).toBe(step.merged);
      base = merged;
    }
  });

  it('状态机：从关键帧起连续 7 条增量全部交付，结果与全量逐字节相等', () => {
    const { dec, requests } = newDecoder();
    const first = dec.apply(bytes(golden.base), 2);
    expect(first?.version).toBe(2);
    expect(dec.lastSeq()).toBe(1);
    for (const step of golden.steps) {
      const got = dec.apply(bytes(step.delta), 3);
      expect(got, `第 ${step.seq} 帧应交付`).not.toBeNull();
      expect(got?.version).toBe(2);
      expect(toHex(got?.payload ?? new Uint8Array())).toBe(step.merged);
      expect(dec.lastSeq()).toBe(step.seq);
    }
    expect(requests).toEqual([]);
    expect(dec.drops()).toBe(0);
  });
});

describe('ver=3 失步语义（只信 base_seq，不猜不缓冲）', () => {
  it('seq 跳变 ⇒ 丢弃 + 请求关键帧一次（去重），关键帧后恢复', () => {
    const { dec, requests } = newDecoder();
    dec.apply(bytes(golden.base), 2);
    // 跳过第 2 帧，直接来第 3 帧（base_seq=2）
    expect(dec.apply(bytes(golden.steps[1]?.delta ?? ''), 3)).toBeNull();
    expect(requests).toEqual([1]);
    expect(dec.drops()).toBe(1);
    // 关键帧在途：再来一条失步增量，不得重复请求
    expect(dec.apply(bytes(golden.steps[2]?.delta ?? ''), 3)).toBeNull();
    expect(requests).toEqual([1]);
    // 关键帧到达（用第 2 帧的全量当作关键帧）：pending 清空、基线 = 2
    const key = dec.apply(bytes(golden.steps[0]?.merged ?? ''), 2);
    expect(key?.version).toBe(2);
    expect(dec.pending()).toBe(false);
    expect(dec.lastSeq()).toBe(2);
    // 之后的连续增量正常交付
    const got = dec.apply(bytes(golden.steps[1]?.delta ?? ''), 3);
    expect(got?.version).toBe(2);
    expect(toHex(got?.payload ?? new Uint8Array())).toBe(golden.steps[1]?.merged);
  });

  it('base_seq 与自己的基线不符 ⇒ 丢弃、不缓冲、不改基线', () => {
    const { dec, requests } = newDecoder();
    dec.apply(bytes(golden.base), 2);
    // 第 4 帧（base_seq=3）落到基线 1 上：假设不符，必须丢弃
    expect(dec.apply(bytes(golden.steps[2]?.delta ?? ''), 3)).toBeNull();
    expect(requests).toEqual([1]);
    expect(dec.drops()).toBe(1);
    expect(dec.lastSeq()).toBe(1);
    // 紧接着的合法增量（第 2 帧）只并进真实基线：坏增量的内容一条都不许混进来
    const got = dec.apply(bytes(golden.steps[0]?.delta ?? ''), 3);
    expect(toHex(got?.payload ?? new Uint8Array())).toBe(golden.steps[0]?.merged);
    expect(dec.lastSeq()).toBe(2);
  });

  it('迟到/重复增量静默丢弃，不发关键帧请求', () => {
    const { dec, requests } = newDecoder();
    dec.apply(bytes(golden.base), 2);
    dec.apply(bytes(golden.steps[0]?.delta ?? ''), 3);
    expect(dec.apply(bytes(golden.steps[0]?.delta ?? ''), 3)).toBeNull();
    expect(dec.apply(bytes(golden.base), 2)).not.toBeNull();
    expect(requests).toEqual([]);
    expect(dec.drops()).toBe(0); // 迟到不算失步（Go 同口径）
  });

  it('没有基线时收到增量 ⇒ 丢弃并请求一次，绝不凭空合并', () => {
    const { dec, requests } = newDecoder();
    expect(dec.apply(bytes(golden.steps[0]?.delta ?? ''), 3)).toBeNull();
    expect(requests).toEqual([0]);
    expect(dec.lastSeq()).toBe(0);
  });

  it('任意坏字节只报 DownlinkError（不 panic、不越界）', () => {
    const { dec } = newDecoder();
    dec.apply(bytes(golden.base), 2);
    const bad = [Uint8Array.from([0xff, 0xff, 0xff]), Uint8Array.from([0x3a, 0x05, 0x01])];
    for (const b of bad) {
      expect(() => dec.apply(b, 3)).toThrow(DownlinkError);
    }
  });
});

describe('帧号读取（补帧基准的共用入口）', () => {
  it('从全量帧读到 frame_id；从增量读到 null（增量不是全量）', () => {
    expect(readFrameId(bytes(golden.base))).toBe(1);
    expect(readFrameId(bytes(golden.steps[0]?.delta ?? ''))).toBeNull();
  });
});

// 会话接入（ws 面）：ver=3 推送先合并再交付（version=2），失步时自动发一次关键帧请求。
// 会话是 SDK 里唯一知道「本战斗会话」的地方，因此状态机实例挂在 BattleInbound 上。
import { waitFor } from './helpers.js';
import { makeBattleFactory } from './battleMock.js';
import { STUB_OP_FRAME, battleDefaults } from './battleStub.js';
import { openBattleSession, parseDirectPlan } from '../src/index.js';
import { OP_REQUEST_FRAME_KEYFRAME } from '../src/battle/opkeys.js';

describe('会话接入：ws 面收到 ver=3 时的合并与恢复', () => {
  it('逐帧交付合并后的全量（version=2）；跳变 ⇒ 发一次 RequestFrameKeyframe', async () => {
    const seen: Array<{ payload: Uint8Array; version: number }> = [];
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => s.replyOK(new TextEncoder().encode(JSON.stringify({ currentFrame: '1' }))));
    });
    const plan = parseDirectPlan({
      matchId: 'm-1',
      battleId: 'b-1',
      battleTicket: Buffer.from([1, 2, 3]).toString('base64'),
      endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: '10.0.0.9:7100' }],
    });
    const s = await openBattleSession(plan, {
      ...battleDefaults('b-1'),
      wsFactory: h.factory,
      frameNumberOf: (payload) => readFrameId(payload),
      onFrame: (payload, version) => void seen.push({ payload, version }),
    });
    await s.invoke('/battle.v1.BattleService/JoinBattle', { battleId: 'b-1' });
    const srv = h.servers[0]!;

    srv.notify(STUB_OP_FRAME, bytes(golden.base), 2);
    await waitFor(() => seen.length === 1);
    expect(seen[0]?.version).toBe(2);
    expect(toHex(seen[0]?.payload ?? new Uint8Array())).toBe(golden.base);
    expect(s.lastSeenFrame()).toBe(1);

    srv.notify(STUB_OP_FRAME, bytes(golden.steps[0]?.delta ?? ''), 3);
    await waitFor(() => seen.length === 2);
    expect(seen[1]?.version).toBe(2);
    expect(toHex(seen[1]?.payload ?? new Uint8Array())).toBe(golden.steps[0]?.merged);
    expect(s.lastSeenFrame()).toBe(2);

    // 丢掉第 3 帧、直接来第 4 帧：丢弃 + 请求关键帧（一次）
    srv.notify(STUB_OP_FRAME, bytes(golden.steps[2]?.delta ?? ''), 3);
    await waitFor(() => srv.countOp(OP_REQUEST_FRAME_KEYFRAME) === 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(2);
    expect(s.lastSeenFrame()).toBe(2);

    // 关键帧（第 3 帧全量）到达：恢复交付，pending 清空
    srv.notify(STUB_OP_FRAME, bytes(golden.steps[1]?.merged ?? ''), 2);
    await waitFor(() => seen.length === 3);
    expect(seen[2]?.version).toBe(2);
    expect(toHex(seen[2]?.payload ?? new Uint8Array())).toBe(golden.steps[1]?.merged);
    expect(s.lastSeenFrame()).toBe(3);
    await s.close();
  });
});
