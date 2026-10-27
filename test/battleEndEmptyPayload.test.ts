// 结束通知的**空载荷**语义（跨 SDK 统一契约，本文件是它在 TS 侧的固化）：
//
//   Go  direct/ended.go            noteEndNotify：len(payload) == 0 ⇒ 不进终态、不回调；
//   C#  BattleSession.Ended.cs     NoteEndNotify：payload.Length == 0 ⇒ 不进终态、不分发；
//   TS  本文件：空载荷**不构成结束信号**——不进终态、不触发 onBattleEnd、也不经统一出口
//       onPush 分发，且**不占用「首投名额」**（其后到达的非空首投照常生效）。
//
// 为什么必须钉住（空载荷是真实可见的线上形态）：
//   1. op 是**推送寻址键**，服务端/中间层构造一条「只有 op、无载荷」的 Notify 并非不可能；
//      旧口径见空即进终态 ⇒ 客户端把「这一局打完了」写进永久状态（ended 不可逆），
//      结算回调却拿到空字节（业务侧解码失败），且此后一切上发都被本地以 BATTLE_ENDED 拒绝。
//   2. 空载荷若占用首投名额，真正带结算的首投随后到达时会被当「补投副本」丢弃 ——
//      结算永久丢失，且无法从任何回调取回。
//   3. 三 SDK 必须一致：Go/C# 都已按「只认非空载荷」收口，TS 不能漂在自己的旧口径上。
//
// 非空载荷：首投进终态、回调恰一次、**从统一出口出去一次**；补投副本（逐个一致或不一致）
// 只比对不改判，**不从任何出口出去**（Go/C# 同口径——三语言在统一出口上只看得见首投）。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, jsonBytes, makeBattleFactory } from './battleMock.js';
import { battleDefaults } from './battleStub.js';
import {
  openBattleSession,
  parseDirectPlan,
  type BattleSession,
  type BattleSessionOptions,
  type WebSocketFactory,
} from '../src/index.js';

/** 结束通知 op（线上寻址键；独立字面量，不读实现常量）。 */
const BATTLE_END = '/battle.v1.BattleEndNotify';
/** 参考票密文（与其他战斗用例同一向量）。 */
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

/** joinOK 默认服务端行为：入局回成功回执（其余 op 回空成功）。 */
function joinOK(srv: MockBattleServer): void {
  srv.onRequest((req, s) => {
    if (req.op === '/battle.v1.BattleService/JoinBattle') s.replyOK(jsonBytes({ currentFrame: '3' }));
    else s.replyOK();
  });
}

/** open 带 mock WS 工厂打开一条直连会话（探针/重放/帧号钩子由测试替身给出）。 */
function open(factory: WebSocketFactory, opts: BattleSessionOptions = {}): Promise<BattleSession> {
  return openBattleSession(planOf(), { ...battleDefaults('b-9'), wsFactory: factory, ...opts });
}

/** sleep 真定时器等待（推送经读循环异步到达，不能只看同步返回）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** END_PAYLOAD 首投结算载荷（protojson 形态；SDK 不解析，只交字节）。 */
const END_PAYLOAD = { battleId: 'b-9', winnerPlayerId: 'p-1' };

describe('结束通知空载荷：不进终态、不回调、不分发（与 Go/C# 同口径）', () => {
  it('① 空载荷：ended() 仍为 false、state 不变、不回调、不经统一出口、连接不收尾', async () => {
    const h = makeBattleFactory(joinOK);
    const ends: Uint8Array[] = [];
    const pushes: string[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 0,
      drainMs: 40, // 若真进了终态：40ms 后连接就被回收，下面的断言会同时暴露
      onBattleEnd: (payload) => void ends.push(payload),
      onPush: (op) => void pushes.push(op),
    });
    h.servers[0]!.notify(BATTLE_END, new Uint8Array(0)); // 只有 op、零载荷
    await sleep(80);
    expect(s.ended()).toBe(false); // 不臆造结束语义（ended 一旦置位不可逆）
    expect(s.state()).toBe('connected'); // 状态不迁移
    expect(s.stats().endedRejects).toBe(0); // 统计也不记「对局正常结束」
    expect(ends.length).toBe(0); // 不触发结算回调
    expect(pushes).not.toContain(BATTLE_END); // 「不分发」：统一出口同样看不到
    expect(h.sockets[0]!.closedBySdk).toBe(false); // 未终态 ⇒ 收尾窗口未启动
    await s.close();
  });

  it('② 非空首投照旧：进终态、回调恰一次、经统一出口透传一次（载荷逐字原样）', async () => {
    const h = makeBattleFactory(joinOK);
    const ends: Uint8Array[] = [];
    const pushed: Uint8Array[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 0,
      drainMs: 40,
      onBattleEnd: (payload) => void ends.push(payload),
      onPush: (op, payload) => {
        if (op === BATTLE_END) pushed.push(payload);
      },
    });
    h.servers[0]!.notify(BATTLE_END, jsonBytes(END_PAYLOAD));
    await waitFor(() => ends.length === 1, 2000);
    await waitFor(() => s.ended(), 2000);
    expect(s.state()).toBe('ended');
    expect(s.stats().endedRejects).toBe(1);
    expect(new TextDecoder().decode(ends[0]!)).toBe(JSON.stringify(END_PAYLOAD));
    expect(pushed.length).toBe(1); // 首投在统一出口可见（C# 的 FrameBroadcastAndBattleEnd_ReachUnifiedExit 同口径）
    expect(new TextDecoder().decode(pushed[0]!)).toBe(JSON.stringify(END_PAYLOAD));
    await s.close();
  });

  it('③ 空载荷不占用首投名额：随后的非空首投照常进终态并回调一次', async () => {
    const h = makeBattleFactory(joinOK);
    const ends: string[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 0,
      drainMs: 40,
      onBattleEnd: (payload) => void ends.push(new TextDecoder().decode(payload)),
    });
    const srv = h.servers[0]!;
    srv.notify(BATTLE_END, new Uint8Array(0)); // 空载荷先到（乱序/无载荷重投）
    await sleep(30);
    expect(s.ended()).toBe(false);
    expect(ends.length).toBe(0);
    srv.notify(BATTLE_END, jsonBytes(END_PAYLOAD)); // 真正带结算的首投随后到达
    await waitFor(() => ends.length === 1, 2000);
    expect(s.ended()).toBe(true); // 空载荷没有消耗掉「首投」这一名额
    expect(JSON.parse(ends[0]!)).toEqual(END_PAYLOAD);
    await s.close();
  });

  it('④ 首投之后的空载荷补投：不再回调、不改判、不经统一出口', async () => {
    const h = makeBattleFactory(joinOK);
    const ends: string[] = [];
    const pushed: Uint8Array[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 0,
      drainMs: 200, // 留出窗口：首投后连接仍在，空载荷副本才会被真正读到
      onBattleEnd: (payload) => void ends.push(new TextDecoder().decode(payload)),
      onPush: (op, payload) => {
        if (op === BATTLE_END) pushed.push(payload);
      },
    });
    const srv = h.servers[0]!;
    srv.notify(BATTLE_END, jsonBytes(END_PAYLOAD));
    await waitFor(() => ends.length === 1, 2000);
    srv.notify(BATTLE_END, new Uint8Array(0)); // 补投路径上的空载荷副本
    await sleep(40);
    expect(ends.length).toBe(1); // 不重放回调
    expect(JSON.parse(ends[0]!)).toEqual(END_PAYLOAD); // 首投为准则，不被空副本改判
    expect(pushed.length).toBe(1); // 空载荷副本不进统一出口
    await s.close();
  });
});
