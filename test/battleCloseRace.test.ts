// P0-7 复现用例转正：close() 与**在途重连拨号**交叠（评审 R3-P0-1）。
//
// 缺陷时序（修复前）：断线触发自动重连 → 拨号挂起（升级未完成）→ close() 收尾（此刻
// transport 仍为 null，release() 无连接可关）→ 拨号这才返回 → 旧实现直接 install + restore：
//   ① 状态从 closed 回退 connected（setState 无守卫）；
//   ② close 之后仍写线 2 帧（restore 的 JoinBattle + SyncFrames）；
//   ③ 该 socket 无人回收（release 已经跑过，install 之后没有第二次关闭）→ 泄漏。
//
// 修复口径（对齐 Go SDK direct.startGeneration 的代次复查）：拨号结果按**代次**作废——
// close() 递增代次，install 前复查代次与关闭标记；作废即关闭该 socket 且**不安装、不写线**。
// 本文件按线上字节（sent/frames）与 socket 回收状态断言，不依赖实现细节。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, MockWebSocket, jsonBytes } from './battleMock.js';
import {
  BattleOps,
  openBattleSession,
  parseDirectPlan,
  type BattleSession,
  type BattleSessionOptions,
  type WebSocketFactory,
} from '../src/index.js';

/** 参考票密文（与 battlePlan.test.ts 同一向量）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);

/** 构造一份只开 WS 面的上线包。 */
function planOf(address = '10.0.0.9:7100') {
  return parseDirectPlan({
    matchId: 'm-7',
    battleId: 'b-9',
    battleTicket: Buffer.from(TICKET).toString('base64'),
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address }],
  });
}

/** GatedHarness 拨号闸门：首次拨号自动完成升级，之后每次拨号**挂起**（不 open），
 *  由测试用 releaseDial 决定它何时返回——用来构造「close 早于拨号返回」的时序。 */
interface GatedHarness {
  factory: WebSocketFactory;
  sockets: MockWebSocket[];
  servers: MockBattleServer[];
  /** held 尚未完成升级的拨号（按拨号顺序）。 */
  held: MockWebSocket[];
  /** releaseDial 放行第 i 个挂起拨号（完成升级）。 */
  releaseDial: (i: number) => void;
}

/** makeGatedFactory 产出「首次自动升级、其后挂起」的拨号工厂。 */
function makeGatedFactory(): GatedHarness {
  const sockets: MockWebSocket[] = [];
  const servers: MockBattleServer[] = [];
  const held: MockWebSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const ws = new MockWebSocket(url);
    const srv = new MockBattleServer(ws);
    srv.onRequest((req, s) => {
      if (req.op === BattleOps.joinBattle) s.replyOK(jsonBytes({ currentFrame: '3' }));
      else s.replyOK();
    });
    sockets.push(ws);
    servers.push(srv);
    if (sockets.length === 1) queueMicrotask(() => ws.serverOpen());
    else held.push(ws);
    return ws;
  };
  return {
    factory,
    sockets,
    servers,
    held,
    releaseDial: (i) => held[i]?.serverOpen(),
  };
}

/** 带 mock WS 工厂打开一条直连会话（各用例统一入口）。 */
function open(factory: WebSocketFactory, opts: BattleSessionOptions = {}): Promise<BattleSession> {
  return openBattleSession(planOf(), { wsFactory: factory, ...opts });
}

/** sleep 真定时器等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('P0-7：close() × 在途重连拨号竞态', () => {
  it('close 后拨号才返回 → 按代次作废：状态不回退、零写入、socket 关闭、不上报失败', async () => {
    const h = makeGatedFactory();
    const failed: unknown[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 15, // 心跳周期取小：若迟到拨号真的装了通道，Ping 必然出现在线上
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      onFailed: (err) => void failed.push(err),
    });
    expect(s.state()).toBe('connected');
    h.servers[0]!.drop(); // 断线 → 自动重连 → 第二次拨号（挂起）
    await waitFor(() => h.held.length === 1, 2000);
    expect(s.state()).toBe('reconnecting');
    await s.close(); // 关闭发生在拨号返回**之前**
    expect(s.state()).toBe('closed');
    h.releaseDial(0); // 拨号此刻才返回：本代已作废
    await sleep(80); // 覆盖 ≥5 个心跳周期
    expect(s.state()).toBe('closed'); // ① 状态不因迟到拨号回退 connected
    expect(s.ended()).toBe(false);
    expect(h.servers[1]!.frames.length).toBe(0); // ② close 后零写入（JoinBattle/SyncFrames/Ping 全无）
    expect(h.sockets[1]!.sent.length).toBe(0);
    expect(h.sockets[1]!.closedBySdk).toBe(true); // ③ socket 被回收（不泄漏）
    expect(failed).toEqual([]); // 关闭不是失败：不触发 onFailed
  });

  it('close 打断退避等待：不再拨号、零写入（与在途拨号同一守卫族）', async () => {
    // 首次拨号成功；之后每次拨号立刻被接入层拒（rejectBeforeOpen）→ 进入退避等待。
    const sockets: MockWebSocket[] = [];
    const servers: MockBattleServer[] = [];
    const factory: WebSocketFactory = (url) => {
      const ws = new MockWebSocket(url);
      const srv = new MockBattleServer(ws);
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) s.replyOK(jsonBytes({ currentFrame: '3' }));
        else s.replyOK();
      });
      sockets.push(ws);
      servers.push(srv);
      queueMicrotask(() => {
        if (sockets.length === 1) ws.serverOpen();
        else {
          ws.onerror?.();
          ws.onclose?.();
        }
      });
      return ws;
    };
    const s = await open(factory, { heartbeatMs: 15, backoffBaseMs: 300, backoffMaxMs: 600 });
    servers[0]!.drop(); // 断线 → 重连拨号失败 → 进入 300ms 退避等待
    await waitFor(() => sockets.length === 2, 2000);
    await s.close(); // 关闭打断退避
    await sleep(400); // 远超退避档位：未被打断则必然再拨
    expect(sockets.length).toBe(2); // 关闭后不再拨号
    expect(s.state()).toBe('closed');
    for (const srv of servers) expect(srv.frames.filter((f) => f.op === BattleOps.ping).length).toBe(0);
  });
});
