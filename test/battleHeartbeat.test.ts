// 战斗直连保活心跳（battle.v1.BattleService/Ping，Tell 无回执）测试：
//   ① 周期到点发出 Ping（op/载荷/票槽/无幂等键，按线上字节断言）；
//   ② close() 清定时器——关闭后不再发 Ping（不泄漏）；
//   ③ 发送失败只回调、不终止会话（状态不降级，随后正常发帧不受影响）；
//   ④ 周期配置生效（heartbeatMs 可配，显式 0 关闭）；
//   ⑤ 与正常发帧互不干扰（请求-响应照常结算，回执不被心跳抢配）。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, jsonBytes, makeBattleFactory } from './battleMock.js';
import {
  BattleOps,
  MsgType,
  openBattleSession,
  parseDirectPlan,
  parseRequestBodyFull,
  readFrameFrom,
  type BattleSession,
  type BattleSessionOptions,
  type WebSocketFactory,
} from '../src/index.js';

/** 参考票密文与它的 base64url 会话槽取值（与 battlePlan.test.ts 同一向量）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);
const SLOT = 'AQID-_8';
const FLAG_SESSION = 0x01;
const FLAG_REQUEST_ID = 0x02;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** isPingFrame 判定一段线上字节是否为 Ping 请求帧（按 flags 感知解帧，与客户端同构）。 */
function isPingFrame(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const r = readFrameFrom(bytes, 0);
  if (!r.ok || r.header.type !== MsgType.Request) return false;
  return parseRequestBodyFull(r.body, r.header.flags ?? 0).operation === BattleOps.ping;
}

/** pingsOf 取该服务端收到的 Ping 帧（复用 battleMock 的收帧记录）。 */
function pingsOf(srv: MockBattleServer) {
  return srv.frames.filter((f) => f.op === BattleOps.ping);
}

describe('战斗直连保活心跳', () => {
  it('周期到点发出 Ping：Tell 语义（带票槽、无幂等键、载荷仅 battleId）', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { heartbeatMs: 20 });
    const srv = h.servers[0]!;
    await waitFor(() => pingsOf(srv).length >= 3);
    const ping = pingsOf(srv)[0]!;
    expect(ping.header.type).toBe(MsgType.Request);
    expect(ping.header.flags! & FLAG_SESSION).toBe(FLAG_SESSION); // 逐帧会话槽带票
    expect(ping.header.flags! & FLAG_REQUEST_ID).toBe(0); // Tell：不带幂等键（无回执）
    expect(ping.session).toBe(SLOT);
    expect(ping.requestID).toBe('');
    expect(JSON.parse(new TextDecoder().decode(ping.payload))).toEqual({ battleId: 'b-9' });
    await s.close();
  });

  it('close() 清定时器：关闭后不再发 Ping（不泄漏）', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { heartbeatMs: 20 });
    const srv = h.servers[0]!;
    await waitFor(() => pingsOf(srv).length >= 2);
    await s.close();
    const after = pingsOf(srv).length;
    await sleep(160); // 8 个周期：定时器未清则必然再发
    expect(pingsOf(srv).length).toBe(after);
    expect(s.state()).toBe('closed');
  });

  it('心跳写失败只回调，不终止会话；失败消除后发帧照常', async () => {
    const h = makeBattleFactory(joinOK);
    const hbErrs: unknown[] = [];
    const failures: unknown[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 20,
      onHeartbeatFailed: (err) => void hbErrs.push(err),
      onFailed: (err) => void failures.push(err),
    });
    const ws = h.sockets[0]!;
    const orig = ws.send.bind(ws);
    let failing = true;
    ws.send = (data: ArrayBuffer | Uint8Array): void => {
      if (failing && isPingFrame(data)) throw new Error('注入写失败');
      orig(data);
    };
    await waitFor(() => hbErrs.length >= 2);
    expect(s.state()).toBe('connected'); // 未因心跳失败降级/终止
    expect(failures).toEqual([]);
    failing = false;
    await expect(s.sendFrameInput({ input: { frameId: '1', payload: 'AQ==' } })).resolves.toBeDefined();
    await waitFor(() => pingsOf(h.servers[0]!).length >= 1);
    await s.close();
  });

  it('周期可配：heartbeatMs 生效；显式 0 关闭心跳', async () => {
    const fast = makeBattleFactory(joinOK);
    const s1 = await open(fast.factory, { heartbeatMs: 20 });
    await sleep(300);
    const fastCount = pingsOf(fast.servers[0]!).length;
    await s1.close();

    const slow = makeBattleFactory(joinOK);
    const s2 = await open(slow.factory, { heartbeatMs: 300 });
    await sleep(300);
    const slowCount = pingsOf(slow.servers[0]!).length;
    await s2.close();

    const off = makeBattleFactory(joinOK);
    const s3 = await open(off.factory, { heartbeatMs: 0 });
    await sleep(250);
    const offCount = pingsOf(off.servers[0]!).length;
    await s3.close();

    expect(fastCount).toBeGreaterThanOrEqual(8); // 300ms 窗口内至少 8 拍
    expect(slowCount).toBeLessThanOrEqual(2); // 同期最多 1...2 拍
    expect(fastCount).toBeGreaterThan(slowCount);
    expect(offCount).toBe(0); // 显式关闭
  });

  it('与正常发帧互不干扰：心跳期间请求-响应照常结算（回执不误配）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) s.replyOK(jsonBytes({ currentFrame: '3' }));
        else if (req.op === BattleOps.syncFrames) s.replyOK(jsonBytes({ currentFrame: '9' }));
        else s.replyOK();
      });
    });
    const s = await open(h.factory, { heartbeatMs: 20 });
    await waitFor(() => pingsOf(h.servers[0]!).length >= 2);
    await expect(s.syncFrames(8)).resolves.toEqual({ currentFrame: '9' });
    await expect(s.sendFrameInput({})).resolves.toBeDefined();
    await waitFor(() => pingsOf(h.servers[0]!).length >= 4); // 心跳仍在继续
    expect(s.state()).toBe('connected');
    await s.close();
  });
});
