// 游戏域消息迁出后的**新接缝**：op 寻址键常量、显式探针、按配置重放、通用 invoke。
//
// 游戏域消息（battle.v1 的 DTO 与 op stub）已迁出 SDK，会话本身不再内建「入局/发帧/补帧/
// 心跳载荷」——它只认 op 名（线上寻址键）与调用方给的载荷。本文件钉四件事：
//   1. 导出的 op 常量与线上取值逐字一致（写错不会编译失败，只会静默发错对象）；
//   2. 未配置探针 ⇒ 一个字节都不发（不裸发现空载荷探针）；
//   3. 重连重放由配置步骤驱动（载荷用当前 last_seen_frame 生成，SDK 不持 DTO）；
//   4. invoke 原样透传调用方载荷：不补 battleId、不改写、空载荷即空 body。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, jsonBytes, makeBattleFactory } from './battleMock.js';
import {
  OP_BATTLE_END_NOTIFY,
  OP_FRAME_BROADCAST,
  OP_JOIN_BATTLE,
  OP_PING,
  OP_PLAYER_OUT_NOTIFY,
  OP_SEND_FRAME_INPUT,
  OP_SYNC_FRAMES,
  NetworkError,
  openBattleSession,
  parseDirectPlan,
  type BattleSession,
  type BattleSessionOptions,
  type ReplayStep,
  type WebSocketFactory,
} from '../src/index.js';
import { jsonFrameNumberOf } from './battleStub.js';

/** TICKET 参考票密文（与其他战斗用例同一向量）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);

/** planOf 构造一份只开 WS 面的上线包。 */
function planOf(address = '10.0.0.9:7100') {
  return parseDirectPlan({
    matchId: 'm-7',
    battleId: 'b-9',
    battleTicket: Buffer.from(TICKET).toString('base64'),
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address }],
  });
}

/** open 打开一条直连会话（缺省不注入探针/重放：由各用例显式给出）。 */
function open(factory: WebSocketFactory, opts: BattleSessionOptions = {}): Promise<BattleSession> {
  return openBattleSession(planOf(), { wsFactory: factory, ...opts });
}

/** payloadOf 按线上字节解出请求载荷（JSON 形态）。 */
function payloadOf(srv: MockBattleServer, index: number): unknown {
  const frame = srv.frames[index]!;
  return JSON.parse(new TextDecoder().decode(frame.payload)) as unknown;
}

describe('op 寻址键常量', () => {
  it('与线上取值逐字一致（独立字面量，不读实现常量）', () => {
    expect(OP_PING).toBe('/battle.v1.BattleService/Ping');
    expect(OP_JOIN_BATTLE).toBe('/battle.v1.BattleService/JoinBattle');
    expect(OP_SEND_FRAME_INPUT).toBe('/battle.v1.BattleService/SendFrameInput');
    expect(OP_SYNC_FRAMES).toBe('/battle.v1.BattleService/SyncFrames');
    expect(OP_FRAME_BROADCAST).toBe('/battle.v1.FrameBroadcast');
    expect(OP_BATTLE_END_NOTIFY).toBe('/battle.v1.BattleEndNotify');
    expect(OP_PLAYER_OUT_NOTIFY).toBe('/battle.v1.PlayerOutNotify');
  });
});

describe('显式探针（WithProbe 的 TS 等价：probe 选项）', () => {
  it('未配置探针 ⇒ 周期再小也一个字节都不发（不裸发现空载荷探针）', async () => {
    const h = makeBattleFactory((srv) => srv.onRequest((_req, s) => s.replyOK()));
    const s = await open(h.factory, { heartbeatMs: 20 });
    await new Promise((r) => setTimeout(r, 120)); // 6 个周期
    expect(h.servers[0]!.frames.length).toBe(0);
    expect(s.stats().heartbeatWriteFailures).toBe(0);
    await s.close();
  });

  it('探针的 op 与载荷由调用方给出（不写死 Ping/battleId）', async () => {
    const h = makeBattleFactory((srv) => srv.onRequest((_req, s) => s.replyOK()));
    const s = await open(h.factory, {
      heartbeatMs: 15,
      probe: { op: '/custom.v1.Probe/Beat', req: { ticket: 't-1' } },
    });
    const srv = h.servers[0]!;
    await waitFor(() => srv.countOp('/custom.v1.Probe/Beat') >= 1);
    expect(payloadOf(srv, 0)).toEqual({ ticket: 't-1' });
    await s.close();
  });
});

describe('重连重放（WithReplay 的 TS 等价：replay 选项）', () => {
  it('重连按配置顺序重放，req 拿到当前 last_seen_frame，载荷原样写线', async () => {
    const seen: number[] = [];
    const steps: ReplayStep[] = [
      { op: '/game.v1.Battle/Join', req: () => ({ battleId: 'b-9' }) },
      {
        op: '/game.v1.Battle/Sync',
        req: (lastSeen) => {
          seen.push(lastSeen);
          return { battleId: 'b-9', lastSeenFrame: String(lastSeen) };
        },
      },
    ];
    const h = makeBattleFactory((srv) => srv.onRequest((_req, s) => s.replyOK()));
    const s = await open(h.factory, {
      probe: undefined,
      replay: steps,
      frameNumberOf: jsonFrameNumberOf,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
    });
    h.servers[0]!.notify(OP_FRAME_BROADCAST, jsonBytes({ frame: { frameId: '4' } }));
    await waitFor(() => s.lastSeenFrame() === 4);
    h.servers[0]!.drop(); // 断线 → 自动重连 → 按 replay 重放
    await waitFor(() => h.servers.length >= 2, 3000);
    const re = h.servers[1]!;
    await waitFor(() => re.frames.length >= 2, 3000);
    expect(re.frames.map((f) => f.op)).toEqual(['/game.v1.Battle/Join', '/game.v1.Battle/Sync']);
    expect(JSON.parse(new TextDecoder().decode(re.frames[1]!.payload))).toEqual({
      battleId: 'b-9',
      lastSeenFrame: '4',
    });
    expect(seen).toEqual([4]); // 补帧基准由调用方的钩子推进，SDK 不解析游戏消息
    await s.close();
  });
});

describe('通用 invoke：载荷由调用方给出、原样上发', () => {
  it('不补 battleId、不改写：对象逐字写线；缺省载荷为空 body', async () => {
    const h = makeBattleFactory((srv) => srv.onRequest((_req, s) => s.replyOK()));
    const s = await open(h.factory, { probe: undefined });
    await s.invoke('/game.v1.Battle/SendFrameInput', { battleId: 'b-9', input: { frameId: '3' } });
    await s.invoke('/game.v1.Battle/Ping');
    const srv = h.servers[0]!;
    expect(srv.frames[0]!.op).toBe('/game.v1.Battle/SendFrameInput');
    expect(payloadOf(srv, 0)).toEqual({ battleId: 'b-9', input: { frameId: '3' } });
    expect(srv.frames[1]!.op).toBe('/game.v1.Battle/Ping');
    expect(srv.frames[1]!.payload.length).toBe(0); // 空载荷：SDK 不臆造字段
    await s.close();
  });

  it('未建连（已关闭）时 invoke 报 NetworkError（不写线）', async () => {
    const h = makeBattleFactory((srv) => srv.onRequest((_req, s) => s.replyOK()));
    const s = await open(h.factory, { probe: undefined });
    await s.close();
    await expect(s.invoke('/game.v1.Battle/Ping')).rejects.toBeInstanceOf(NetworkError);
  });
});
