// ver=3 增量合并（与 atlas-game-layout/lib/downlink/merge.go 语义逐条对齐）。
//
// 合并规则（设计 §3.2）：
//   - frame_id = delta.seq（隐含，不单独传）；
//   - battle_id 增量永不携带 → 沿用基线；
//   - server_time：changed 含 SERVER_TIME 时用绝对纳秒替换，否则沿用基线；
//   - inputs：先按 removed_player_ids 删除，再按 player_id 用 set_inputs 整条覆盖/追加，
//     未提及的保持基线；最后把全部 frame_id 改写为 seq；
//   - snapshot：changed 含 SNAPSHOT 时用本条替换（缺失 = 本帧无快照），否则沿用基线；
//   - state_hash：**总是**用当帧增量自带的值覆盖（空 = 本帧未算哈希，绝不回退基线）。
import {
  allBytes,
  asBytes,
  concat,
  encodeField,
  firstBytes,
  firstVarint,
  lengthDelimited,
  parseFields,
  tag,
  toNumber,
  varint,
  varintField,
  type WireField,
} from './wire.js';

/** FRAME_DELTA_FIELD 与 battle.v1.FrameDeltaField 的数值一一对应（协议常量，勿另立）。 */
export const FrameDeltaField = {
  SERVER_TIME: 1,
  INPUTS: 2,
  SNAPSHOT: 3,
} as const;

/** DeltaFields 是 FrameBroadcastDelta 的解码结果（只保留合并需要的字段）。 */
export interface DeltaFields {
  baseSeq: number;
  seq: number;
  changed: Set<number>;
  serverTimeUnixNano: bigint;
  setInputs: Uint8Array[];
  removedPlayerIds: string[];
  /** snapshot 字段是否出现（出现但为空 = 本帧无快照，即「清空」）。 */
  snapshot: Uint8Array | null;
  stateHash: Uint8Array | null;
}

/** frameFields 是 FrameBroadcast 的解码骨架。 */
interface FullFrame {
  battleId: Uint8Array | null;
  frame: Uint8Array | null;
}

/** parseDelta 解出 FrameBroadcastDelta（字段号见 api/battle/v1/battle_service.proto）。 */
export function parseDelta(payload: Uint8Array): DeltaFields {
  const f = parseFields(payload);
  const changed = new Set<number>();
  // changed 是 repeated enum（proto3 默认 packed）；proto.Unmarshal 也接受非 packed，两种都收。
  for (const field of f) {
    if (field.no !== 3) continue;
    if (field.wire === 0) {
      changed.add(Number(field.value as bigint));
    } else if (field.wire === 2) {
      let off = 0;
      const packed = asBytes(field);
      while (off < packed.length) {
        const v = readPackedVarint(packed, off);
        changed.add(Number(v.value));
        off = v.next;
      }
    }
  }
  const decoder = new TextDecoder();
  return {
    baseSeq: Number(firstVarint(f, 1)),
    seq: Number(firstVarint(f, 2)),
    changed,
    serverTimeUnixNano: BigInt.asIntN(64, firstVarint(f, 4)),
    setInputs: allBytes(f, 5),
    removedPlayerIds: allBytes(f, 6).map((b) => decoder.decode(b)),
    snapshot: firstBytes(f, 7),
    stateHash: firstBytes(f, 8),
  };
}

/** readFrameId 从全量 FrameBroadcast 字节读 frame.frame_id（读不到返回 null）。 */
export function readFrameId(payload: Uint8Array): number | null {
  try {
    const frame = firstBytes(parseFields(payload), 2);
    if (frame === null) return null;
    return toNumber(firstVarint(parseFields(frame), 1));
  } catch {
    return null;
  }
}

/** mergeDelta 把增量并进基线，返回新的全量 FrameBroadcast 字节（不改入参）。 */
export function mergeDelta(base: Uint8Array, delta: DeltaFields): Uint8Array {
  const bf = parseFields(base);
  const battleId = firstBytes(bf, 1);
  const frameRaw = firstBytes(bf, 2);
  const frame = frameRaw === null ? [] : parseFields(frameRaw);

  const baseInputs = allBytes(frame, 2);
  const baseServerTime = firstBytes(frame, 4);
  const baseSnapshot = firstBytes(frame, 5);
  const stateHash = delta.stateHash ?? new Uint8Array(0);

  const inputs = mergeInputs(baseInputs, delta);
  const serverTime = delta.changed.has(FrameDeltaField.SERVER_TIME)
    ? encodeTimestamp(delta.serverTimeUnixNano)
    : baseServerTime;
  const snapshot = delta.changed.has(FrameDeltaField.SNAPSHOT) ? delta.snapshot : baseSnapshot;

  const mergedFrame = concat([
    varintField(1, BigInt(delta.seq)),
    ...inputs.map((input) => messageField(2, input)),
    lengthDelimited(3, stateHash),
    serverTime === null ? new Uint8Array(0) : messageField(4, serverTime),
    snapshot === null ? new Uint8Array(0) : messageField(5, snapshot),
  ]);
  return concat([
    battleId === null ? new Uint8Array(0) : lengthDelimited(1, battleId),
    messageField(2, mergedFrame),
  ]);
}

/** mergeInputs 按 player_id 稀疏替换，并把全部输入改写成本帧帧号。 */
function mergeInputs(baseInputs: readonly Uint8Array[], delta: DeltaFields): Uint8Array[] {
  const removed = new Set(delta.removedPlayerIds);
  const pending = new Map<string, Uint8Array>();
  for (const raw of delta.setInputs) pending.set(playerIdOf(raw), raw);
  const out: Uint8Array[] = [];
  for (const raw of baseInputs) {
    const id = playerIdOf(raw);
    if (removed.has(id)) continue;
    const repl = pending.get(id);
    if (repl !== undefined) {
      pending.delete(id);
      out.push(rewriteFrameId(repl, delta.seq));
      continue;
    }
    out.push(rewriteFrameId(raw, delta.seq));
  }
  for (const raw of delta.setInputs) {
    const id = playerIdOf(raw);
    if (!pending.has(id)) continue;
    out.push(rewriteFrameId(raw, delta.seq));
  }
  return out;
}

/** playerIdOf 读输入的 player_id（字段 2）。 */
function playerIdOf(raw: Uint8Array): string {
  const b = firstBytes(parseFields(raw), 2);
  return b === null ? '' : new TextDecoder().decode(b);
}

/** rewriteFrameId 复制一条输入并把 frame_id（字段 1）改写为 seq，其余字段原样保留。 */
function rewriteFrameId(raw: Uint8Array, seq: number): Uint8Array {
  const fields = parseFields(raw)
    .filter((f) => f.no !== 1)
    .sort((a, b) => a.no - b.no);
  return concat([varintField(1, BigInt(seq)), ...fields.map((f) => encodeField(f))]);
}

/** encodeTimestamp 把绝对纳秒编码成 google.protobuf.Timestamp（与 timestamppb.New 同口径）。 */
function encodeTimestamp(nanos: bigint): Uint8Array {
  const billion = 1_000_000_000n;
  let seconds = nanos / billion;
  let rest = nanos % billion;
  if (rest < 0n) {
    seconds -= 1n;
    rest += billion;
  }
  return concat([
    varintField(1, BigInt.asUintN(64, seconds)),
    varintField(2, rest),
  ]);
}

/** messageField 编码一条消息字段（**空消息也要带 tag**：presence 是协议语义）。 */
function messageField(no: number, bytes: Uint8Array): Uint8Array {
  return concat([tag(no, 2), varint(BigInt(bytes.length)), bytes]);
}

/** readPackedVarint 读 packed repeated 里的一个 varint。 */
function readPackedVarint(buf: Uint8Array, off: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = off;
  for (let n = 0; n < 10; n++) {
    if (i >= buf.length) throw new Error('downlink: packed varint 截断');
    const b = buf[i++] as number;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
  }
  throw new Error('downlink: packed varint 超长');
}

/** wireFieldsOf 仅供测试/调试：暴露字段列表（不参与合并逻辑）。 */
export function wireFieldsOf(payload: Uint8Array): WireField[] {
  return parseFields(payload);
}
