// 三 SDK 一致性收口（评审 R3-P1）在 TS 侧的固化，按**钉死的契约**逐条断言：
//
//   ① BATTLE_NOT_FOUND（404 / biz 3001）与 BATTLE_FULL（409 / biz 3002）是**不可重试的
//      终态业务拒绝**，与 BATTLE_ENDED 同族（可判定常量 + 判定函数）：会话终态化（停发、
//      停心跳、释放连接、不重连）并**经既有失败出口 onFailed 上报**；
//   ② 心跳回执被业务拒绝此前**完全不可见**（无 pending，settle 当迟到结果丢弃）：
//      终态类 → 入终态 + 上报；票类 → 不终态、计数 + 首见上报「需重新取票」信号；
//      其余 → 计数 + 每次经心跳失败出口暴露（继续探测、不重连）；
//   ③ 终态时在途请求**立即以终态 Status 结算**（reason/code/class 对齐、metadata 标本地结算），
//      不等回执/超时、不报成网络错误；
//   ④ 可观测（P1-4）：拨号（握手）/重连/心跳失败只读统计快照。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, isOpFrame, jsonBytes, makeBattleFactory } from './battleMock.js';
import {
  BATTLE_FULL_CODE,
  BATTLE_FULL_REASON,
  BATTLE_NOT_FOUND_CODE,
  BATTLE_NOT_FOUND_REASON,
  BattleOps,
  BusinessError,
  FRAME_TARGET_MISMATCH_CODE,
  FRAME_TARGET_MISMATCH_REASON,
  LOCAL_SETTLED_KEY,
  isBattleEnded,
  isBattleFull,
  isBattleNotFound,
  isBattleTerminalReject,
  isBattleTicketExpired,
  isFrameTargetMismatch,
  openBattleSession,
  parseDirectPlan,
  type BattleSession,
  type BattleSessionOptions,
  type Status,
  type WebSocketFactory,
} from '../src/index.js';

/** 参考票密文与它的 base64url 会话槽取值（与 battlePlan.test.ts 同一向量）。 */
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

/** statusOf 构造一份服务端业务拒绝 Status（class 缺省 1 = 业务类，与生成物口径一致）。 */
function statusOf(code: number, reason: string, errorClass = 1, metadata?: Record<string, string>): Status {
  return { code, reason, message: `${reason}（服务端拒绝）`, class: errorClass, ...(metadata ? { metadata } : {}) };
}

/** sleep 真定时器等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** sendFrames 发两条帧输入并收集结算结果（在途结算用例共用）。 */
async function twoInFlight(s: BattleSession): Promise<unknown[]> {
  const first = s.sendFrameInput({ input: { frameId: '1' } }).catch((e: unknown) => e);
  const second = s.sendFrameInput({ input: { frameId: '2' } }).catch((e: unknown) => e);
  return Promise.all([first, second]);
}

describe('① 终态族：BATTLE_NOT_FOUND / BATTLE_FULL 不可重试、终态化并上报', () => {
  it('BATTLE_NOT_FOUND（404/biz 3001）→ 终态 failed + onFailed 上报 + 停发 + 不重连', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) srv.replyOK(jsonBytes({ currentFrame: '3' }));
        else if (req.op === BattleOps.sendFrameInput) {
          srv.replyStatusOf(statusOf(BATTLE_NOT_FOUND_CODE, BATTLE_NOT_FOUND_REASON));
        } else srv.replyOK();
      });
    });
    const failed: unknown[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 15,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      onFailed: (err) => void failed.push(err),
    });
    const err = await s.sendFrameInput({ input: { frameId: '1' } }).catch((e: unknown) => e);
    // 服务端拒绝原样上抛且可判定（判定函数 + 常量与 BATTLE_ENDED 同族）。
    expect(err).toBeInstanceOf(BusinessError);
    expect(isBattleNotFound(err)).toBe(true);
    expect(isBattleTerminalReject(err)).toBe(true);
    expect(isBattleEnded(err)).toBe(false); // 不是「对局已结束」：两者 reason 互斥
    expect((err as BusinessError).code).toBe(BATTLE_NOT_FOUND_CODE);
    // 终态化 + 上报（既有失败出口，分类一致）。
    expect(s.state()).toBe('failed');
    expect(s.ended()).toBe(false); // 无结算可展示：不是对局打完
    // 统计能区分两族终态：本族 = 无结算的终态拒绝（fatalRejects），不是「对局正常结束」。
    expect(s.stats().fatalRejects).toBe(1);
    expect(s.stats().endedRejects).toBe(0);
    expect(s.stats().terminalRejects).toBe(1); // 总数 = endedRejects + fatalRejects
    expect(failed.length).toBe(1);
    expect(isBattleNotFound(failed[0])).toBe(true);
    const bytesAtEnd = h.sockets[0]!.sent.length;
    await sleep(80); // 覆盖 ≥5 个心跳周期
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd); // 停发（含心跳 Ping）
    expect(h.sockets.length).toBe(1); // 不重连（会话无用）
    await waitFor(() => h.sockets[0]!.closedBySdk, 2000); // 终态即回收连接（不泄漏）
    // 终态下显式重连同样被同一终态拒绝，且不写线、不新增拨号。
    const reErr = await s.reconnect().catch((e: unknown) => e);
    expect(isBattleNotFound(reErr)).toBe(true);
    expect(h.sockets.length).toBe(1);
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd);
    await s.close();
    expect(s.state()).toBe('closed');
  });

  it('BATTLE_FULL（409/biz 3002）→ 同一族终态（判定函数/常量口径一致）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) srv.replyOK(jsonBytes({ currentFrame: '3' }));
        else if (req.op === BattleOps.sendFrameInput) {
          srv.replyStatusOf(statusOf(BATTLE_FULL_CODE, BATTLE_FULL_REASON));
        } else srv.replyOK();
      });
    });
    const failed: unknown[] = [];
    const s = await open(h.factory, { heartbeatMs: 0, onFailed: (err) => void failed.push(err) });
    const err = await s.sendFrameInput({}).catch((e: unknown) => e);
    expect(isBattleFull(err)).toBe(true);
    expect(isBattleTerminalReject(err)).toBe(true);
    expect(isBattleEnded(err)).toBe(false);
    expect((err as BusinessError).code).toBe(BATTLE_FULL_CODE);
    expect(s.state()).toBe('failed');
    expect(failed.length).toBe(1);
    expect(isBattleFull(failed[0])).toBe(true);
    expect(s.stats().fatalRejects).toBe(1); // 同一族的统计口径
    expect(s.stats().endedRejects).toBe(0);
    expect(h.sockets.length).toBe(1);
    await s.close();
  });

  it('FRAME_TARGET_MISMATCH（403）：票面对局与正文目标不一致 → 同族终态（不可重试 + 上报 + 停发）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) srv.replyOK(jsonBytes({ currentFrame: '3' }));
        else if (req.op === BattleOps.sendFrameInput) {
          srv.replyStatusOf(statusOf(FRAME_TARGET_MISMATCH_CODE, FRAME_TARGET_MISMATCH_REASON));
        } else srv.replyOK();
      });
    });
    const failed: unknown[] = [];
    const s = await open(h.factory, { heartbeatMs: 15, onFailed: (err) => void failed.push(err) });
    const err = await s.sendFrameInput({}).catch((e: unknown) => e);
    expect(isFrameTargetMismatch(err)).toBe(true);
    expect(isBattleTerminalReject(err)).toBe(true); // 与 BATTLE_ENDED 同族：不可重试
    expect(isBattleEnded(err)).toBe(false); // 但 reason 互斥（不是对局打完）
    expect((err as BusinessError).code).toBe(FRAME_TARGET_MISMATCH_CODE);
    expect(s.state()).toBe('failed');
    expect(failed.length).toBe(1);
    expect(isFrameTargetMismatch(failed[0])).toBe(true); // 上报（不按未知 403 落进重试循环）
    expect(s.stats().fatalRejects).toBe(1);
    expect(s.stats().endedRejects).toBe(0);
    const bytesAtEnd = h.sockets[0]!.sent.length;
    await sleep(80);
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd); // 入终态后不再发送（含心跳）
    expect(h.sockets.length).toBe(1); // 不重连
    await s.close();
  });

  it('③ 终态时在途请求立即以终态 Status 结算（不等回执、不报成网络错误）', async () => {
    const h = makeBattleFactory((srv) => {
      let inputs = 0;
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.joinBattle) return s.replyOK(jsonBytes({ currentFrame: '3' }));
        if (req.op === BattleOps.sendFrameInput) {
          inputs += 1;
          if (inputs === 2) s.replyStatusOf(statusOf(BATTLE_NOT_FOUND_CODE, BATTLE_NOT_FOUND_REASON));
          return; // 第一条不回执：由终态本地结算
        }
        s.replyOK();
      });
    });
    const s = await open(h.factory, { invokeTimeoutMs: 60_000, heartbeatMs: 0, onFailed: () => {} });
    const [e1, e2] = await twoInFlight(s);
    for (const err of [e1, e2]) {
      expect(err).toBeInstanceOf(BusinessError); // 不是 NetworkError/TimeoutError
      expect(isBattleNotFound(err)).toBe(true);
      const be = err as BusinessError;
      expect(be.code).toBe(BATTLE_NOT_FOUND_CODE);
      expect(be.reason).toBe(BATTLE_NOT_FOUND_REASON);
      expect(be.errorClass).toBe(1); // class=business
      expect(be.metadata?.[LOCAL_SETTLED_KEY]).toBe('true'); // metadata 标「本地结算」
    }
    await s.close();
  });

  it('重连恢复入局时收到终态拒绝：入终态、上报恰一次、不继续重连', async () => {
    const h = makeBattleFactory((srv, index) => {
      srv.onRequest((req, s) => {
        if (index === 0) {
          // 首连正常（JoinBattle 回成功回执）
          if (req.op === BattleOps.joinBattle) s.replyOK(jsonBytes({ currentFrame: '3' }));
          else s.replyOK();
          return;
        }
        if (req.op === BattleOps.joinBattle) {
          s.replyStatusOf(statusOf(BATTLE_NOT_FOUND_CODE, BATTLE_NOT_FOUND_REASON)); // 新一代入局被拒
          return;
        }
        s.replyOK();
      });
    });
    const failed: unknown[] = [];
    const s = await open(h.factory, {
      heartbeatMs: 0,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      onFailed: (err) => void failed.push(err),
    });
    h.servers[0]!.drop(); // 断线 → 自动重连 → 新一代 JoinBattle 撞终态拒绝
    await waitFor(() => s.state() === 'failed', 3000);
    await sleep(60); // 若有重连循环，这段时间足够再拨几次
    expect(failed.length).toBe(1); // 上报恰一次（终态收口报过，重连循环的失败不再重复报）
    expect(isBattleNotFound(failed[0])).toBe(true);
    expect(s.stats().terminalRejects).toBe(1);
    expect(s.stats().fatalRejects).toBe(1); // 无结算的终态拒绝（不是「对局正常结束」）
    expect(s.stats().endedRejects).toBe(0);
    expect(h.sockets.length).toBe(2); // 不继续重连
    await s.close();
  });
});

describe('② 心跳回执被业务拒绝：记账 + 分类处置', () => {
  it('非终态类（INTERNAL）：计数 + 经心跳失败出口暴露，状态不变、不重连、继续可用', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.ping) srv.replyStatusOf(statusOf(500, 'INTERNAL'));
        else srv.replyOK();
      });
    });
    const hbErrs: unknown[] = [];
    const s = await open(h.factory, { heartbeatMs: 15, onHeartbeatFailed: (err) => void hbErrs.push(err) });
    await waitFor(() => hbErrs.length >= 2, 2000);
    expect(s.state()).toBe('connected'); // 不终态
    expect(s.ended()).toBe(false);
    expect(s.stats().heartbeatRejected).toBeGreaterThanOrEqual(2);
    expect(s.stats().lastHeartbeatRejectReason).toBe('INTERNAL');
    expect(s.stats().heartbeatWriteFailures).toBe(0); // 业务拒绝与本地写失败分开计
    expect(hbErrs[0]).toBeInstanceOf(BusinessError);
    expect(h.sockets.length).toBe(1); // 心跳被拒从不触发重连
    await expect(s.sendFrameInput({ input: { frameId: '1' } })).resolves.toBeDefined(); // 继续探测/可用
    await s.close();
  });

  it('票类（BATTLE_TICKET_EXPIRED）：不终态、计数，且「需重新取票」信号只上报一次', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.ping) srv.replyStatusOf(statusOf(401, 'BATTLE_TICKET_EXPIRED'));
        else srv.replyOK();
      });
    });
    const hbErrs: unknown[] = [];
    const s = await open(h.factory, { heartbeatMs: 15, onHeartbeatFailed: (err) => void hbErrs.push(err) });
    await waitFor(() => s.stats().heartbeatRejected >= 3, 2000); // 多拍被拒
    await sleep(60); // 再跑几拍
    expect(s.stats().heartbeatRejected).toBeGreaterThanOrEqual(4);
    expect(s.stats().heartbeatTicketRejected).toBeGreaterThanOrEqual(3);
    expect(s.stats().lastHeartbeatRejectReason).toBe('BATTLE_TICKET_EXPIRED');
    expect(hbErrs.length).toBe(1); // 状态首次变化只上报一条（不每拍刷）
    expect(isBattleTicketExpired(hbErrs[0])).toBe(true); // 「需重新取票」信号可判定
    expect(s.state()).toBe('connected'); // 票类不终态（回业务链路重新取票）
    expect(h.sockets.length).toBe(1);
    await s.close();
  });

  it('终态类（BATTLE_NOT_FOUND）：入终态 + 上报 + 停心跳（不必等业务调用撞墙）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        if (req.op === BattleOps.ping) srv.replyStatusOf(statusOf(BATTLE_NOT_FOUND_CODE, BATTLE_NOT_FOUND_REASON));
        else srv.replyOK();
      });
    });
    const failed: unknown[] = [];
    const s = await open(h.factory, { heartbeatMs: 15, onFailed: (err) => void failed.push(err) });
    await waitFor(() => s.state() === 'failed', 2000);
    expect(s.stats().heartbeatRejected).toBeGreaterThanOrEqual(1);
    expect(isBattleNotFound(failed[0])).toBe(true);
    const bytesAtEnd = h.sockets[0]!.sent.length;
    await sleep(80);
    expect(h.sockets[0]!.sent.length).toBe(bytesAtEnd); // 心跳已停：零写入
    expect(h.sockets.length).toBe(1);
    await s.close();
  });
});

describe('④ 可观测：拨号（握手）/重连/心跳失败只读统计', () => {
  it('重连成功计数：dialAttempts / reconnects；快照只读', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { backoffBaseMs: 5, backoffMaxMs: 10, heartbeatMs: 0 });
    expect(s.stats().dialAttempts).toBe(1);
    expect(s.stats().dialFailures).toBe(0);
    expect(s.stats().reconnects).toBe(0);
    h.servers[0]!.drop();
    await waitFor(() => s.state() === 'connected' && h.sockets.length >= 2, 3000);
    expect(s.stats().dialAttempts).toBe(2);
    expect(s.stats().reconnects).toBe(1);
    expect(s.stats().dialFailures).toBe(0);
    expect(Object.isFrozen(s.stats())).toBe(true); // 只读快照（调用方改不动内部计数）
    await s.close();
  });

  it('握手失败计数：窗口内拨不通 → dialFailures 增长、reconnects 为 0', async () => {
    const h = makeBattleFactory((srv, index) => {
      if (index === 0) joinOK(srv);
      else srv.ws.rejectBeforeOpen = true;
    });
    const s = await open(h.factory, {
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      reconnectWindowMs: 40,
      heartbeatMs: 0,
      onFailed: () => {},
    });
    h.servers[0]!.drop();
    await waitFor(() => s.state() === 'failed', 3000);
    const st = s.stats();
    expect(st.dialAttempts).toBeGreaterThan(1);
    expect(st.dialFailures).toBeGreaterThanOrEqual(1);
    expect(st.reconnects).toBe(0);
    await s.close();
  });

  it('心跳写失败计数：本地写失败与业务拒绝分开计', async () => {
    const h = makeBattleFactory(joinOK);
    const s = await open(h.factory, { heartbeatMs: 15 });
    const ws = h.sockets[0]!;
    const orig = ws.send.bind(ws);
    ws.send = (data: ArrayBuffer | Uint8Array): void => {
      if (isOpFrame(data, BattleOps.ping)) throw new Error('注入写失败');
      orig(data);
    };
    await waitFor(() => s.stats().heartbeatWriteFailures >= 2, 2000);
    expect(s.stats().heartbeatRejected).toBe(0);
    await s.close();
  });
});
