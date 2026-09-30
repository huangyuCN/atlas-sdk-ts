// 战斗直连会话（openBattleSession）测试：升级带票、逐帧会话槽带票、三个战斗 op 直连、
// 推送回调、断线重连（重新 JoinBattle/SyncFrames 补帧）、票过期回退与
// 「接入层拒连 vs 网络断开」的错误分类（规格 §7 / §9.4 / §9.5）。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, jsonBytes, makeBattleFactory } from './battleMock.js';
import {
  BattleOps,
  BusinessError,
  NetworkError,
  ProtocolError,
  TimeoutError,
  isBattleTicketExpired,
  isEdgeRejected,
  openBattleSession,
  parseDirectPlan,
  ticketSlotValue,
  type BattleSession,
  type BattleSessionOptions,
  type WebSocketFactory,
} from '../src/index.js';

/** 参考票密文与它的 base64url 会话槽取值（与 battlePlan.test.ts 同一向量）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);
const SLOT = 'AQID-_8';
const FRAME_BROADCAST = '/battle.v1.FrameBroadcast';
const BATTLE_END = '/battle.v1.BattleEndNotify';

/** 构造一份只开 WS 面的上线包。 */
function planOf(address = '10.0.0.9:7100') {
  return parseDirectPlan({
    matchId: 'm-7',
    battleId: 'b-9',
    battleTicket: Buffer.from(TICKET).toString('base64'),
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address }],
  });
}

/** 默认服务端行为：JoinBattle 回成功回执（其余 op 回空成功）。 */
function joinOK(srv: MockBattleServer): void {
  srv.onRequest((req, s) => {
    if (req.op === BattleOps.joinBattle) s.replyOK(jsonBytes({ currentFrame: '3' }));
    else s.replyOK();
  });
}

/** 带 mock WS 工厂打开一条直连会话（各用例统一入口）。 */
function open(factory: WebSocketFactory, opts: BattleSessionOptions = {}): Promise<BattleSession> {
  return openBattleSession(planOf(), { wsFactory: factory, ...opts });
}

describe('openBattleSession 建连与首帧', () => {
  it('升级 URL 带 ?ticket=<base64url>，首帧会话槽字节与票据密文逐字节一致', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory);
    // 升级请求行：地址取本局推送的 WS 面，票为 base64url（RawURLEncoding，无填充）。
    expect(h.urls[0]).toBe(`ws://10.0.0.9:7100/?ticket=${SLOT}`);
    const first = h.servers[0]!.frames[0]!;
    expect(first.op).toBe(BattleOps.joinBattle);
    expect(first.session).toBe(SLOT);
    // 逐字节一致：槽值用 Node Buffer（独立于被测实现）解回票密文。
    expect(new Uint8Array(Buffer.from(first.session, 'base64url'))).toEqual(TICKET);
    expect(ticketSlotValue(TICKET)).toBe(SLOT);
    expect(JSON.parse(new TextDecoder().decode(first.payload))).toEqual({ battleId: 'b-9' });
    await s.close();
  });

  it('请求帧置位 FLAG_SESSION 与 FLAG_REQUEST_ID（段序 operation → 槽 → 幂等键 → 载荷）', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory);
    const f = h.servers[0]!.frames[0]!;
    expect((f.header.flags ?? 0) & 0x01).toBe(0x01); // FLAG_SESSION
    expect((f.header.flags ?? 0) & 0x02).toBe(0x02); // FLAG_REQUEST_ID
    expect(f.requestID.length).toBeGreaterThan(0);
    await s.close();
  });

  it('sendFrameInput 自动补 battleId；syncFrames 的 lastSeenFrame 按 protojson 字符串下发', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory);
    await s.sendFrameInput({ input: { frameId: '4', payload: 'AQ==' } });
    await s.syncFrames(6);
    const frames = h.servers[0]!.frames;
    const input = frames.find((f) => f.op === BattleOps.sendFrameInput)!;
    expect(JSON.parse(new TextDecoder().decode(input.payload))).toEqual({
      battleId: 'b-9',
      input: { frameId: '4', payload: 'AQ==' },
    });
    const sync = frames.find((f) => f.op === BattleOps.syncFrames)!;
    expect(JSON.parse(new TextDecoder().decode(sync.payload))).toEqual({
      battleId: 'b-9',
      lastSeenFrame: '6',
    });
    expect(sync.session).toBe(SLOT); // 每个战斗 op 都带票槽
    await s.close();
  });

  it('请求无回执 → TimeoutError（可判定，不静默成功）', async () => {
    const h = makeBattleFactory(() => {}); // 服务端不回任何回执
    await expect(open(h.factory, { invokeTimeoutMs: 30 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('战斗域推送回调', () => {
  it('帧广播：onFrame 回调 + lastSeenFrame 前进（protojson frameId 字符串）', async () => {
    const h = makeBattleFactory(joinOK);
    const seen: number[] = [];
    const s = await open(h.factory, { onFrame: () => void seen.push(s.lastSeenFrame()) });
    h.servers[0]!.notify(FRAME_BROADCAST, jsonBytes({ battleId: 'b-9', frame: { frameId: '7' } }));
    await waitFor(() => s.lastSeenFrame() === 7);
    expect(seen[0]).toBe(7);
    await s.close();
  });

  it('战斗结束：onBattleEnd 收到原始载荷；未识别 op 走 onPush', async () => {
    const h = makeBattleFactory(joinOK);
    const end: Uint8Array[] = [];
    const others: string[] = [];
    const s = await open(h.factory, {
      onBattleEnd: (payload) => void end.push(payload),
      onPush: (op) => void others.push(op),
    });
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    await waitFor(() => end.length === 1);
    expect(JSON.parse(new TextDecoder().decode(end[0]!))).toEqual({ battleId: 'b-9', winnerPlayerId: 'p-1' });
    h.servers[0]!.notify('/battle.v1.OtherNotify', new Uint8Array(0));
    await waitFor(() => others.length >= 2);
    await s.close();
  });

  it('推送回调抛异常不影响读循环（后续请求仍可往返）', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, {
      onFrame: () => {
        throw new Error('业务回调炸了');
      },
    });
    h.servers[0]!.notify(FRAME_BROADCAST, jsonBytes({ frame: { frameId: '1' } }));
    await waitFor(() => s.lastSeenFrame() === 1);
    await expect(s.syncFrames(1)).resolves.toBeDefined(); // 读循环未被打断
    await s.close();
  });
});

describe('错误分类：接入层拒连 / 票过期 / 网络断开', () => {
  it('升级前被断（无 101）→ 不可重试的接入层拒连，且不重试', async () => {
    const h = makeBattleFactory((srv) => {
      srv.ws.rejectBeforeOpen = true;
    });
    const err = await open(h.factory).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(isEdgeRejected(err)).toBe(true);
    expect((err as NetworkError).retryable).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.urls.length).toBe(1); // 不重试
  });

  it('升级后无回执被断 → 判为接入层拒连（不重试）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) s.drop(); // 升级成功但无任何回执即断开
      });
    });
    const err = await open(h.factory).catch((e: unknown) => e);
    expect(isEdgeRejected(err)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.urls.length).toBe(1);
  });

  it('票过期（服务端 reason BATTLE_TICKET_EXPIRED）→ 可判定业务错误供上层重新匹配', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) s.replyStatus('BATTLE_TICKET_EXPIRED');
      });
    });
    const err = await open(h.factory).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect(isBattleTicketExpired(err)).toBe(true);
    expect(h.urls.length).toBe(1); // 票过期不重试，回业务链路重新取票
  });

  it('会话中途网络断开 → 自动退避重连（同一张票重新升级），非协议错误', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { backoffBaseMs: 5, backoffMaxMs: 10 });
    h.servers[0]!.drop();
    await waitFor(() => h.urls.length >= 2, 3000);
    expect(h.urls[1]).toBe(`ws://10.0.0.9:7100/?ticket=${SLOT}`);
    await waitFor(() => s.state() === 'connected', 3000);
    await s.close();
  });

  it('关闭后不再自动重连；close 幂等；关闭后调用战斗 op 报 NetworkError', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { backoffBaseMs: 5, backoffMaxMs: 10 });
    await s.close();
    await s.close();
    h.servers[0]!.drop();
    await new Promise((r) => setTimeout(r, 40));
    expect(h.urls.length).toBe(1);
    expect(s.state()).toBe('closed');
    await expect(s.joinBattle()).rejects.toBeInstanceOf(NetworkError);
  });

  it('接入层拒连不是 ProtocolError（协议错误才终止不重连）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.ws.rejectBeforeOpen = true;
    });
    const err = await open(h.factory).catch((e: unknown) => e);
    expect(err instanceof ProtocolError).toBe(false);
  });
});

describe('reconnect 重连与补帧', () => {
  it('重连后重新 JoinBattle 并以 SyncFrames(last_seen_frame) 补帧，槽仍带同一张票', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { backoffBaseMs: 5, backoffMaxMs: 10 });
    h.servers[0]!.notify(FRAME_BROADCAST, jsonBytes({ frame: { frameId: '7' } }));
    await waitFor(() => s.lastSeenFrame() === 7);
    h.servers[0]!.drop();
    await waitFor(() => h.servers.length >= 2, 3000);
    const re = h.servers[1]!;
    await waitFor(() => re.countOp(BattleOps.syncFrames) === 1, 3000);
    expect(re.countOp(BattleOps.joinBattle)).toBe(1);
    expect(re.frames.every((f) => f.session === SLOT)).toBe(true);
    const sync = re.frames.find((f) => f.op === BattleOps.syncFrames)!;
    expect(JSON.parse(new TextDecoder().decode(sync.payload)))
      .toEqual({ battleId: 'b-9', lastSeenFrame: '7' });
    expect(s.state()).toBe('connected');
    await s.close();
  });

  it('reconnect() 已连接时幂等（不重复拨号）', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { backoffBaseMs: 5, backoffMaxMs: 10 });
    await s.reconnect();
    expect(h.urls.length).toBe(1);
    await s.close();
  });

  it('重连窗口内一直拨不通 → 窗口用尽返回不可重试的接入层拒连错误', async () => {
    const h = makeBattleFactory((srv, index) => {
      if (index === 0) joinOK(srv);
      else srv.ws.rejectBeforeOpen = true; // 首次之后的拨号一律被接入层拒
    });
    const s = await open(h.factory, { backoffBaseMs: 5, backoffMaxMs: 10, reconnectWindowMs: 60 });
    h.servers[0]!.drop();
    await waitFor(() => s.state() === 'failed', 3000); // 自动重连窗口用尽
    expect(h.urls.length).toBeGreaterThan(1);
    const err = await s.reconnect().catch((e: unknown) => e); // 显式重连再试一轮窗口
    expect(isEdgeRejected(err)).toBe(true);
    await s.close();
  });
});
