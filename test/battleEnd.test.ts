// 对局结束语义收口（跨机验收暴露的三件事）：**终态停发 / 补投幂等 / 收尾窗口**。
//
// 服务端已就绪的语义（battle 帧面，见 atlas-game-layout services/battle/internal/{server,stream}）：
//   1. 已结束的对局对**任何**迟到帧 op（含 Ping、JoinBattle、SendFrameInput、SyncFrames）
//      一律以稳定 reason **BATTLE_ENDED**（409）拒绝——与 BATTLE_TICKET_INVALID/EXPIRED 互斥
//      （identity.Resolve 在「投递之前」判 Ended，免得 SpawnAuto 重建空名单实例）；
//   2. 结算结果**可能重复投递**：结算关闭前对每条未确认连接重投 EndRetries=2 次
//      （CloseBattle → repushEnd），玩家带票重连时按 MaxEndReplays=5 有界补投（ReplayEnd）；
//      同一局的载荷由留档（EndedBook）唯一确定，故逐字一致。
//
// 本文件锁定 SDK 侧对应的四条语义：
//   ① 收到 BATTLE_ENDED → 进终态：心跳与业务发帧全停，**零写入**（假 WS 上逐字节计数）；
//   ② 同一局结束通知重复到达（含载荷不一致）→ onBattleEnd 只回调一次；
//   ③ 终态下调用战斗 op → 明确错误（isBattleEnded 可判定），一次也不写线；
//   ④ 收尾窗口：窗口内继续收结果推送，窗口到点自行释放连接；close() 清定时器（无悬挂）。
import { describe, expect, it, vi } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, jsonBytes, makeBattleFactory } from './battleMock.js';
import {
  BattleOps,
  BusinessError,
  LOCAL_SETTLED_KEY,
  isBattleEnded,
  openBattleSession,
  parseDirectPlan,
  type BattleSession,
  type BattleSessionOptions,
  type WebSocketFactory,
} from '../src/index.js';

/** 参考票密文与它的 base64url 会话槽取值（与 battleSession.test.ts 同一向量）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);
const BATTLE_END = '/battle.v1.BattleEndNotify';
/** BATTLE_ENDED 服务端拒绝的 HTTP 语义码（battle 侧 ErrBattleEnded → 409）。 */
const BATTLE_ENDED_CODE = 409;

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

/** sleep 真定时器等待（假定时器用例不用它）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** flushMicrotasks 推进微任务队列（假定时器下不能用 waitFor 轮询：那条路本身要 setTimeout）。 */
async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** 一条「终态下调用」的探针：名字 + 调用体（断言错误与零写入共用）。 */
type Probe = [string, () => Promise<unknown>];

describe('BATTLE_ENDED：终态与停发', () => {
  it('业务调用收到 BATTLE_ENDED → 进终态：心跳停、随后零写入（假 WS 逐字节计数）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.sendFrameInput) srv.replyStatus('BATTLE_ENDED', BATTLE_ENDED_CODE);
        else srv.replyOK();
      });
    });
    const s = await open(h.factory, { heartbeatMs: 15 });
    await waitFor(() => h.servers[0]!.countOp(BattleOps.ping) >= 1, 2000); // 心跳确实在跑
    const err = await s.sendFrameInput({ input: { frameId: '1' } }).catch((e: unknown) => e);
    expect(isBattleEnded(err)).toBe(true); // 服务端拒绝原样上抛（可判定）
    expect(s.ended()).toBe(true);
    expect(s.state()).toBe('ended');
    // 统计两族可区分：本族 = 对局正常结束（**有结算可展示**），不是无结算的终态拒绝。
    expect(s.stats().endedRejects).toBe(1);
    expect(s.stats().fatalRejects).toBe(0);
    expect(s.stats().terminalRejects).toBe(1);
    // 终态即刻停发：再无任何字节写上线（心跳周期 15ms，等 80ms 足够排除泄漏的定时器）。
    const bytesAtEnd = h.sockets[0]!.sent.length;
    await sleep(80);
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd);
    await s.close();
  });

  it('心跳 Ping 的 BATTLE_ENDED 回执（无 pending）也进终态——不必等业务调用撞墙', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.ping) srv.replyStatus('BATTLE_ENDED', BATTLE_ENDED_CODE);
        else srv.replyOK();
      });
    });
    const s = await open(h.factory, { heartbeatMs: 15 });
    await waitFor(() => s.ended(), 2000);
    expect(s.state()).toBe('ended');
    const bytesAtEnd = h.sockets[0]!.sent.length;
    await sleep(80);
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd); // 心跳循环已停（不含在途心跳）
    expect(h.servers[0]!.countOp(BattleOps.ping)).toBeLessThanOrEqual(2);
    await s.close();
  });

  it('在途请求遇上对局结束 → 以 BATTLE_ENDED 立即结算（不静默成功、不等到超时）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) srv.replyOK(jsonBytes({ currentFrame: '3' })); // 之后一律不回执
      });
    });
    const s = await open(h.factory, { invokeTimeoutMs: 60_000 }); // 超时远大于用例时长
    const inflight = s.sendFrameInput({ input: { frameId: '3' } });
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    const err = await inflight.catch((e: unknown) => e);
    expect(isBattleEnded(err)).toBe(true); // 在途请求当场了结为终态拒绝，而不是干等超时
    await s.close();
  });

  it('终态后连接被断 → 不自动重拨（不因掉线回到重连循环、不报失败）', async () => {
    const h = makeBattleFactory(joinOK);
    // autoReconnect 保持缺省开：本用例验证的是终态守卫，而不是把重连关掉。
    const failed: unknown[] = [];
    const s = await open(h.factory, {
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      onFailed: (err) => void failed.push(err),
    });
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    await waitFor(() => s.ended());
    h.servers[0]!.drop(); // 服务端结算后回收连接
    await sleep(60);
    expect(h.urls.length).toBe(1); // 不重拨：同一张票再拨也只会被 BATTLE_ENDED 拒
    expect(s.state()).toBe('ended'); // 不因掉线回到 reconnecting/failed
    expect(failed.length).toBe(0);
    await s.close();
  });

  it('重连恢复入局时收到 BATTLE_ENDED：终态保持 ended、不上报 Failed、不重连', async () => {
    const h = makeBattleFactory((srv, index) => {
      srv.onRequest((req, s) => {
        if (index === 0) {
          if (req.op === BattleOps.joinBattle) s.replyOK(jsonBytes({ currentFrame: '3' }));
          else s.replyOK();
          return;
        }
        if (req.op === BattleOps.joinBattle) s.replyStatus('BATTLE_ENDED', BATTLE_ENDED_CODE); // 新一代入局被拒
        else s.replyOK();
      });
    });
    const failed: unknown[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 0,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      onFailed: (err) => void failed.push(err),
    });
    h.servers[0]!.drop(); // 断线 → 自动重连 → 新一代 JoinBattle 撞 BATTLE_ENDED
    await waitFor(() => s.ended(), 3000);
    await sleep(60);
    expect(s.state()).toBe('ended'); // 对局结束是终态：不被降级成 failed
    expect(s.ended()).toBe(true);
    expect(failed).toEqual([]); // 对局结束不是失败（上报 Failed 会误导上层重新匹配，与 Go/C# 同口径）
    expect(h.urls.length).toBe(2); // 不继续重连
    await s.close();
  });

  it('终态下帧输入/补帧/入局/重连一律报明确错误 BATTLE_ENDED，且零写入', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory);
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    await waitFor(() => s.ended());
    const bytesAtEnd = h.sockets[0]!.sent.length;
    const probes: Probe[] = [
      ['sendFrameInput', () => s.sendFrameInput({ input: { frameId: '2' } })],
      ['syncFrames', () => s.syncFrames(1)],
      ['joinBattle', () => s.joinBattle()],
      ['reconnect', () => s.reconnect()],
    ];
    for (const [name, call] of probes) {
      const err = await call().catch((e: unknown) => e);
      expect(isBattleEnded(err), `${name} 应报 BATTLE_ENDED`).toBe(true);
      expect(err, `${name} 应抛 BusinessError`).toBeInstanceOf(BusinessError);
    }
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd); // 探针一次都没写线
    await s.close();
  });

  it('③ 终态时在途请求以终态 Status 本地结算（reason/code/class 对齐，metadata 标本地结算）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) srv.replyOK(jsonBytes({ currentFrame: '3' })); // 其余不回执
      });
    });
    const s = await open(h.factory, { invokeTimeoutMs: 60_000, heartbeatMs: 0 }); // 超时远大于用例时长
    const first = s.sendFrameInput({ input: { frameId: '1' } }).catch((e: unknown) => e);
    const second = s.sendFrameInput({ input: { frameId: '2' } }).catch((e: unknown) => e);
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    for (const err of await Promise.all([first, second])) {
      expect(err).toBeInstanceOf(BusinessError); // 不报成网络错误、不等超时
      expect(isBattleEnded(err)).toBe(true);
      const be = err as BusinessError;
      expect(be.code).toBe(BATTLE_ENDED_CODE);
      expect(be.reason).toBe('BATTLE_ENDED');
      expect(be.errorClass).toBe(1); // class=business（与生成物 ErrBattleEnded 同分类）
      expect(be.metadata?.[LOCAL_SETTLED_KEY]).toBe('true'); // 本地结算标记（三 SDK 统一键名）
    }
    await s.close();
  });
});

describe('结算通知补投的幂等', () => {
  it('同一局结束通知重复到达（有界重投 + 补投）→ onBattleEnd 只回调一次', async () => {
    const h = makeBattleFactory(joinOK);
    const end: string[] = [];
    const pushed: string[] = [];
    const s = await open(h.factory, {
      onBattleEnd: (payload) => void end.push(new TextDecoder().decode(payload)),
      onPush: (op, payload) => {
        if (op === BATTLE_END) pushed.push(new TextDecoder().decode(payload));
      },
    });
    const srv = h.servers[0]!;
    // 结算前的有界重投（EndRetries=2）+ 重连补投（MaxEndReplays=5）合计最多 5 份同载荷副本。
    const first = { battleId: 'b-9', winnerPlayerId: 'p-1' };
    for (let i = 0; i < 5; i++) srv.notify(BATTLE_END, jsonBytes(first));
    await waitFor(() => pushed.length === 5, 2000);
    expect(end.length).toBe(1); // 幂等：只回调一次
    expect(JSON.parse(end[0]!)).toEqual(first);
    expect(pushed.length).toBe(5); // 重复副本仍经 onPush 透传（可观测、可上报）
    await s.close();
  });

  it('载荷不一致的重复通知：以先到者为准（结算不可改判），不改回调次数', async () => {
    const h = makeBattleFactory(joinOK);
    const end: string[] = [];
    const s = await open(h.factory, { onBattleEnd: (payload) => void end.push(new TextDecoder().decode(payload)) });
    const srv = h.servers[0]!;
    const first = { battleId: 'b-9', winnerPlayerId: 'p-1' };
    const other = { battleId: 'b-9', winnerPlayerId: 'p-9' };
    srv.notify(BATTLE_END, jsonBytes(first));
    await waitFor(() => end.length === 1, 2000);
    srv.notify(BATTLE_END, jsonBytes(other));
    srv.notify(BATTLE_END, jsonBytes(first));
    await sleep(30);
    expect(end.length).toBe(1); // 后到的副本（无论一致与否）都不再回调
    expect(JSON.parse(end[0]!)).toEqual(first); // 首份结算为准则，不被后到的改判
    await s.close();
  });

  it('BATTLE_ENDED 拒绝先到、结束通知后到（补投）→ 结束通知仍回调一次', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.syncFrames) srv.replyStatus('BATTLE_ENDED', BATTLE_ENDED_CODE);
        else srv.replyOK();
      });
    });
    const end: string[] = [];
    const s = await open(h.factory, { onBattleEnd: (payload) => void end.push(new TextDecoder().decode(payload)) });
    // 先由业务拒绝置终态（此时还没有结算载荷）。
    await expect(s.syncFrames(1)).rejects.toSatisfy((e: unknown) => isBattleEnded(e));
    expect(s.ended()).toBe(true);
    expect(end.length).toBe(0);
    // 服务端的留档补投随后到达：结算结果不能因为「先撞了拒绝」而丢失。
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    await waitFor(() => end.length === 1, 2000);
    expect(JSON.parse(end[0]!)).toEqual({ battleId: 'b-9', winnerPlayerId: 'p-1' });
    await s.close();
  });
});

describe('收尾窗口与无泄漏', () => {
  it('窗口内继续收结果推送；窗口到点自行释放连接，终态保持可判定', async () => {
    const h = makeBattleFactory(joinOK);
    const pushes: string[] = [];
    const s = await open(h.factory, { drainMs: 40, onPush: (op) => void pushes.push(op) });
    const srv = h.servers[0]!;
    srv.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    await waitFor(() => s.ended());
    srv.notify('/battle.v1.PlayerOutNotify', jsonBytes({ battleId: 'b-9' })); // 结算前后仍在途的结果
    await waitFor(() => pushes.includes('/battle.v1.PlayerOutNotify'), 2000);
    await waitFor(() => h.sockets[0]!.closedBySdk, 2000); // 窗口到点：SDK 自行回收连接
    expect(s.state()).toBe('ended'); // 终态不因连接释放而改变
    expect(s.ended()).toBe(true);
    await s.close(); // 幂等
    expect(s.state()).toBe('closed');
    expect(s.ended()).toBe(true); // close 后仍可判定「是对局结束」而非普通关闭
  });

  it('close() 清理收尾窗口定时器：不悬挂任何待触发计时器', async () => {
    vi.useFakeTimers();
    try {
      const h = makeBattleFactory(joinOK);
      const s = await open(h.factory, { heartbeatMs: 0, autoReconnect: false, drainMs: 60_000 });
      const baseline = vi.getTimerCount(); // 建连握手/入局回执的定时器此时都已结算
      h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
      await flushMicrotasks();
      expect(s.state()).toBe('ended');
      expect(vi.getTimerCount()).toBe(baseline + 1); // 只有收尾窗口这一个待触发定时器
      await s.close();
      expect(vi.getTimerCount()).toBe(baseline); // close 已把它清掉
      await vi.advanceTimersByTimeAsync(120_000); // 快进远超窗口：没有任何迟到回调
      expect(s.state()).toBe('closed'); // 不因窗口定时器回落成 ended/failed
      expect(h.sockets[0]!.closedBySdk).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drainMs=0：结束通知即释放连接（不等窗口）', async () => {
    const h = makeBattleFactory(joinOK);
    const end: number[] = [];
    const s = await open(h.factory, { drainMs: 0, onBattleEnd: () => void end.push(1) });
    h.servers[0]!.notify(BATTLE_END, jsonBytes({ battleId: 'b-9', winnerPlayerId: 'p-1' }));
    await waitFor(() => h.sockets[0]!.closedBySdk, 2000);
    expect(s.ended()).toBe(true);
    expect(end.length).toBe(1); // 回调照常（先回调、后释放）
    await s.close();
  });
});
