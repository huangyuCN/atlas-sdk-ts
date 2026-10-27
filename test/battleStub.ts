// 战斗直连用例的**游戏域线上形态替身**：游戏域消息（battle.v1 的 DTO 与 op stub）已迁出
// SDK，用例改用「op 字面量 + 最小对象/裸字节」表达线上载荷——断言因此独立于任何生成物
// （真实项目用游戏协议包的生成 DTO 与 op 常量，这里只需要线上形态等价）。
//
// 覆盖三件套（生产上同样由游戏侧提供）：
//   - 探针：probeOf —— op 字面量 + `{battleId}`（真实项目用协议包的 PingReq）；
//   - 重连重放：replayOf —— 入局、按 last_seen_frame 补帧（真实项目用协议包的 DTO）；
//   - 帧号钩子：jsonFrameNumberOf —— ver=1 的 protojson 帧广播按 `frame.frameId` 取帧号
//     （SDK 已删掉内建解析：载荷属游戏协议，不猜编码）。
import type { BattleSession, BattleSessionOptions, ReplayStep } from '../src/index.js';

/** 入局 op（线上寻址键；与协议包生成的 op 常量同值）。 */
export const STUB_OP_JOIN = '/battle.v1.BattleService/JoinBattle';
/** 发帧 op。 */
export const STUB_OP_INPUT = '/battle.v1.BattleService/SendFrameInput';
/** 补帧 op。 */
export const STUB_OP_SYNC = '/battle.v1.BattleService/SyncFrames';
/** 保活探针 op。 */
export const STUB_OP_PING = '/battle.v1.BattleService/Ping';
/** 帧广播推送 op（按消息完整名寻址）。 */
export const STUB_OP_FRAME = '/battle.v1.FrameBroadcast';
/** 战斗结束通知推送 op。 */
export const STUB_OP_END = '/battle.v1.BattleEndNotify';
/** 出局通知推送 op。 */
export const STUB_OP_OUT = '/battle.v1.PlayerOutNotify';

/** joinPayload 构造入局载荷（protojson 形态：只带客体寻址字段）。 */
export function joinPayload(battleId: string): Record<string, unknown> {
  return { battleId };
}

/** inputPayload 构造帧输入载荷（payload 为位移字节的 base64）。 */
export function inputPayload(battleId: string, frameId: number, payload = 'AA=='): Record<string, unknown> {
  return { battleId, input: { frameId: String(frameId), payload } };
}

/** syncPayload 构造补帧载荷（uint64 按 protojson 约定下发字符串）。 */
export function syncPayload(battleId: string, lastSeenFrame: number): Record<string, unknown> {
  return { battleId, lastSeenFrame: String(lastSeenFrame) };
}

/** probeOf 返回测试用探针（PingReq 等价体：只带本局对局标识）。 */
export function probeOf(battleId: string): { op: string; req: unknown } {
  return { op: STUB_OP_PING, req: joinPayload(battleId) };
}

/** replayOf 返回测试用重放步骤：先入局、再按当前补帧基准补帧（与旧内建重放等价）。 */
export function replayOf(battleId: string): ReplayStep[] {
  return [
    { op: STUB_OP_JOIN, req: () => joinPayload(battleId) },
    { op: STUB_OP_SYNC, req: (lastSeen) => syncPayload(battleId, lastSeen) },
  ];
}

/** jsonFrameNumberOf 是测试侧的帧号钩子：按帧广播的 protojson 形态取 `frame.frameId`
 *  （真实项目用协议包解码；SDK 不持游戏消息、不猜编码）。取不到返回 null。 */
export function jsonFrameNumberOf(payload: Uint8Array): number | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(payload)) as { frame?: { frameId?: unknown } };
    const raw = obj.frame?.frameId;
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** battleDefaults 返回用例统一注入的会话选项：探针 + 重连重放 + 帧号钩子
 *  （生产同样由调用方用游戏协议包提供这三件事，SDK 不内建）。 */
export function battleDefaults(battleId: string): BattleSessionOptions {
  return {
    probe: probeOf(battleId),
    replay: replayOf(battleId),
    frameNumberOf: jsonFrameNumberOf,
  };
}

/** join 发一次入局（错误原样返回，供终态/拒绝类用例断言）。 */
export function join(session: BattleSession, battleId: string): Promise<unknown> {
  return session.invoke(STUB_OP_JOIN, joinPayload(battleId));
}

/** sendFrameInput 发一帧输入（错误原样返回）。 */
export function sendFrameInput(
  session: BattleSession,
  battleId: string,
  frameId: number,
  payload = 'AA==',
): Promise<unknown> {
  return session.invoke(STUB_OP_INPUT, inputPayload(battleId, frameId, payload));
}

/** syncFrames 补一次帧（基准取会话当前已见帧号）。 */
export function syncFrames(session: BattleSession, battleId: string, lastSeen = session.lastSeenFrame()): Promise<unknown> {
  return session.invoke(STUB_OP_SYNC, syncPayload(battleId, lastSeen));
}
