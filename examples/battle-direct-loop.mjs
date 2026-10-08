// battle-direct-loop：跨机「服务器级闭环 + 直连保活」驱动（本机 Node 客户端 → 真服务）。
//
// 链路（全程真跑，无 mock）：
//   1) 业务链路经网关 ws://<gateway>（注册/登录 → 入队匹配 → 等成局推送）拿到
//      { battle_ticket, endpoints }；
//   2) 按 EDGE_TRANSPORT_WS 取接入层地址，**经接入层直连**（升级 URL 带 base64url 票据，
//      逐帧会话槽带同一张票）跑 JoinBattle → SendFrameInput → SyncFrames → 收帧广播；
//   3) 保活验收：局中「只发心跳、不发输入」的静默窗口（A 心跳在线），断言未被判出局、
//      窗口后仍能发帧/补帧；同参数对照 B（心跳关闭）观察是否掉线。
//
// 观测手段：wsFactory 包装真实 WebSocket，按线上字节解码**客户端发出的每一帧**
//   （readFrameFrom + parseRequestBodyFull，与 SDK 同一份实现）——「只发心跳」不是推断，
//   而是逐帧计数（Ping 帧数 / SendFrameInput 帧数）。
//
// 用法：node examples/battle-direct-loop.mjs [--gateway 10.10.9.36:9002]
//        [--silence-ms 8000] [--heartbeat-ms 2000] [--idle-ms 5000]
//        [--max-frames 60] [--tick-ms 100] [--ruleset casual]
// 依赖 dist 产物：先 npx tsup。
import {
  BattleOps,
  CLIENT_VERSION,
  isEdgeRejected,
  MsgType,
  newWSClient,
  openBattleSession,
  parseDirectPlan,
  parseRequestBodyFull,
  readFrameFrom,
  WithInvokeTimeout,
} from '../dist/index.js';
import { sessionOps } from './gatewayv1.mjs';
import { matchPushOps, playerOps } from './gamev1.mjs';
import { PlayerOutNotifySchema } from './gen/api/battle/v1/battle_service_pb.js';

// ---- CLI 参数 ----
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const GATEWAY = arg('gateway', '10.10.9.36:9002');
const SILENCE_MS = Number(arg('silence-ms', '8000'));
const HEARTBEAT_MS = Number(arg('heartbeat-ms', '2000'));
const IDLE_MS = Number(arg('idle-ms', '5000')); // battle.offline_timeout/3（数据报面 idle 读超时）
const MAX_FRAMES = Number(arg('max-frames', '60')); // battle 帧上限缺省（服务端硬缺省，无配置项）
const TICK_MS = Number(arg('tick-ms', '100')); // battle 帧间隔缺省
const RULESET = arg('ruleset', 'casual');
const PASSWORD = 'pw-123456';
const OP_OUT = `/${PlayerOutNotifySchema.typeName}`;

const T0 = Date.now();
const log = (...a) => console.log(...a);
const stamp = (t = Date.now()) => `+${((t - T0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** deferred 一次性信号（resolve 幂等）。 */
function deferred() {
  const box = {};
  box.promise = new Promise((resolve) => {
    box.resolve = resolve;
  });
  return box;
}

/** withTimeout 给 Promise 加超时（超时抛错并带上现场描述）。 */
async function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待${what}超时（${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** wireRecorder 包装真实 WebSocket 工厂：逐帧解码客户端发出的帧（线上字节口径）。 */
function wireRecorder() {
  const sent = [];
  const factory = (url) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const origSend = ws.send.bind(ws);
    ws.send = (data) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const r = readFrameFrom(bytes, 0);
      if (r.ok && r.header.type === MsgType.Request) {
        const p = parseRequestBodyFull(r.body, r.header.flags ?? 0);
        sent.push({ t: Date.now(), op: p.operation, session: p.session, requestID: p.requestID });
      }
      return origSend(data);
    };
    return ws;
  };
  return { factory, sent, count: (op, since = 0) => sent.filter((f) => f.op === op && f.t >= since).length };
}

/** registerAndLogin 注册（撞号换号重试）+ 登录，返回 playerId。 */
async function registerAndLogin(client, tag) {
  let account = `direct-${tag}-${Date.now()}`;
  let reg;
  for (let i = 0; ; i++) {
    try {
      reg = await client.invoke(sessionOps.register, { account, password: PASSWORD, nickname: `直连${tag}` });
      break;
    } catch (err) {
      if (err?.reason === 'PLAYER_ALREADY_EXISTS' && i < 5) {
        account = `direct-${tag}-${Date.now()}-${i}`;
        continue;
      }
      throw err;
    }
  }
  const playerId = reg.playerId;
  await client.invoke(sessionOps.login, {
    playerId,
    password: PASSWORD,
    clientVersion: CLIENT_VERSION,
    clientEnd: 'ts-direct-loop',
  });
  return playerId;
}

/** newPlayer 建一条业务链路（网关 WS）+ 注册登录。 */
async function newPlayer(tag) {
  const client = await newWSClient(GATEWAY, [WithInvokeTimeout(5000)]);
  const playerId = await registerAndLogin(client, tag);
  return { tag, client, playerId };
}

/** enqueue 订阅成局/失败推送后入队（推送先订阅后入队，避免漏收）。 */
async function enqueue(player) {
  const started = deferred();
  const failed = deferred();
  player.client.on(matchPushOps.matchStartedNotify, (_op, payload) => started.resolve(payload));
  player.client.on(matchPushOps.matchFailedNotify, (_op, payload) => failed.resolve(payload));
  await player.client.invoke(playerOps.enterMatchQueue, { ruleset: RULESET });
  const notify = await withTimeout(
    Promise.race([
      started.promise,
      failed.promise.then((p) => {
        throw new Error('成局失败推送: ' + new TextDecoder().decode(p));
      }),
    ]),
    30_000,
    '成局通知',
  );
  player.plan = parseDirectPlan(notify);
}

/** openDirect 经接入层直连（升级带票）+ JoinBattle（autoJoin 关，拿 currentFrame）。 */
async function openDirect(player, heartbeatMs) {
  const rec = wireRecorder();
  const stats = { tag: player.tag, frames: [], pushes: [], battleEndAt: null, failedAt: null, failedErr: null, hbFailures: [] };
  const session = await openBattleSession(player.plan, {
    heartbeatMs,
    autoReconnect: false,
    wsFactory: rec.factory,
    onFrame: () => stats.frames.push(Date.now()),
    onBattleEnd: () => {
      stats.battleEndAt = Date.now();
    },
    onPush: (op) => stats.pushes.push({ t: Date.now(), op }),
    onFailed: (err) => {
      stats.failedAt = Date.now();
      stats.failedErr = err;
    },
    onHeartbeatFailed: (err) => stats.hbFailures.push(err),
  });
  const join = await session.joinBattle();
  return { session, rec, stats, join };
}

/** openDirectRetry 接入层刚开局时后端可能尚未可解析（backend_unavailable）——按拒连重试。 */
async function openDirectRetry(player, heartbeatMs, attempts = 10) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await openDirect(player, heartbeatMs);
    } catch (err) {
      if (!isEdgeRejected(err)) throw err; // 业务拒绝/协议错误不重试
      lastErr = err;
      log(`[重试] ${player.tag} 第 ${i} 次直连被接入层拒（${err.message.slice(0, 40)}…），250ms 后重试`);
      await sleep(250);
    }
  }
  throw lastErr;
}

/** sendInput 发一条帧输入（payload 单字节 0：证明链路且不推进赛道）。 */
function sendInput(session, frameId) {
  return session.sendFrameInput({ input: { frameId: String(frameId), payload: 'AA==' } });
}

/** waitFrames 等到收到至少 n 条帧广播（超时抛错）。 */
async function waitFrames(stats, n, ms = 5000) {
  const deadline = Date.now() + ms;
  while (stats.frames.length < n) {
    if (Date.now() > deadline) throw new Error(`${stats.tag} 仅收到 ${stats.frames.length} 条帧广播`);
    await sleep(20);
  }
}

/** closeQuiet 关会话与业务连接（收尾不抛错）。 */
async function closeQuiet(session, client) {
  await session?.close().catch(() => {});
  await client?.close().catch(() => {});
}

/** runClosedLoop 阶段 1+2：闭环（入队成局 → 直连 → 入局/发帧/补帧/收广播）。 */
async function runClosedLoop() {
  log(`[业务] 网关 ${GATEWAY}：两条业务链路注册/登录中…`);
  const a = await newPlayer('loop-a');
  const b = await newPlayer('loop-b');
  log(`[业务] 注册/登录 OK：A=${a.playerId} B=${b.playerId}（${stamp()}）`);
  await Promise.all([enqueue(a), enqueue(b)]);
  log(`[业务] 入队 ${RULESET} → 双双收到成局通知（${stamp()}）`);
  const plan = a.plan;
  const faces = [...plan.endpoints].map(([k, v]) => `${k}=${v}`).join('、');
  log(`[闭环] 成局推送：matchId=${plan.matchId} battleId=${plan.battleId}`);
  log(`[闭环] endpoints 面选择：${faces} → 取 EDGE_TRANSPORT_WS=${plan.endpoints.get('EDGE_TRANSPORT_WS')}`);
  const da = await openDirectRetry(a, HEARTBEAT_MS);
  const db = await openDirectRetry(b, HEARTBEAT_MS);
  log(`[闭环] 经接入层直连：${da.session.address}（升级 query 带票 + 逐帧会话槽带票）`);
  log(`[闭环] JoinBattle OK：A currentFrame=${da.join?.currentFrame} B currentFrame=${db.join?.currentFrame}`);
  await Promise.all([sendInput(da.session, 1), sendInput(db.session, 1)]);
  await Promise.all([sendInput(da.session, 2), sendInput(db.session, 2)]);
  await Promise.all([waitFrames(da.stats, 1), waitFrames(db.stats, 1)]);
  const sync = await da.session.syncFrames(1);
  log(
    `[闭环] SendFrameInput OK（A/B 各 2 帧）→ 收到帧广播 A=${da.stats.frames.length} 条/B=${db.stats.frames.length} 条；` +
      `SyncFrames OK（currentFrame=${sync?.currentFrame} missed=${sync?.missed?.length ?? 0}）`,
  );
  log(
    `[闭环] 接入层直连帧计数：A ping=${da.rec.count(BattleOps.ping)} input=${da.rec.count(BattleOps.sendFrameInput)} ` +
      `sync=${da.rec.count(BattleOps.syncFrames)}`,
  );
  await closeQuiet(da.session, a.client);
  await closeQuiet(db.session, b.client);
  return { battleId: plan.battleId, ws: plan.endpoints.get('EDGE_TRANSPORT_WS') };
}

/** silenceWindow 静默观察：只发心跳、不发输入，直到窗口到点/对局自然结束。 */
async function silenceWindow(da, windowMs) {
  const silenceAt = Date.now();
  while (Date.now() - silenceAt < windowMs && da.stats.battleEndAt === null) await sleep(50);
  return silenceAt;
}

/** resumeAfterSilence 窗口后继续发帧 + 补帧（对局若已自然结算则如实标注）。 */
async function resumeAfterSilence(da, silenceAt) {
  if (da.stats.battleEndAt !== null || da.session.state() !== 'connected') {
    log('[保活] 窗口后动作：对局已自然结算（帧上限），窗口后未再发帧');
    return false;
  }
  await sendInput(da.session, 3);
  const sync = await da.session.syncFrames(1);
  log(
    `[保活] 窗口后动作：SendFrameInput OK + SyncFrames OK（currentFrame=${sync?.currentFrame}，` +
      `距静默起点 ${((Date.now() - silenceAt) / 1000).toFixed(1)}s）`,
  );
  return true;
}

/** observeNaturalEnd 等对局自然结算（帧上限）收尾：区分「自然结算」与「掉线判负」。 */
async function observeNaturalEnd(da, db, silenceAt) {
  const deadline = Date.now() + 4_000;
  while (da.stats.battleEndAt === null && Date.now() < deadline) await sleep(50);
  const outs = da.stats.pushes.filter((p) => p.op === OP_OUT);
  if (da.stats.battleEndAt === null) {
    log('[保活] 对局自然结算：观察窗内未收到结束通知（对局仍未结束）');
    return;
  }
  log(
    `[保活] 对局自然结算：A 于静默起点 +${((da.stats.battleEndAt - silenceAt) / 1000).toFixed(1)}s 收到结束通知；` +
      `全程出局通知=${outs.length} 条（未被判出局）；A 连接随后由服务端回收` +
      `（对局结束前是否掉线=${da.stats.failedAt !== null && da.stats.failedAt < da.stats.battleEndAt ? '是' : '否'}；` +
      `B 收到结束通知=${db.stats.battleEndAt !== null ? '是' : '否'}）`,
  );
}

/** measureSilence 统计静默窗口内的线上帧计数与「距最后一次输入 ≥ 阈值」后的帧广播数。 */
function measureSilence(da, silenceAt) {
  const inputs = da.rec.sent.filter((f) => f.op === BattleOps.sendFrameInput);
  const lastInputAt = inputs.length > 0 ? inputs[inputs.length - 1].t : silenceAt;
  return {
    pings: da.rec.count(BattleOps.ping, silenceAt),
    inputs: da.rec.count(BattleOps.sendFrameInput, silenceAt),
    afterThreshold: da.stats.frames.filter((t) => t - lastInputAt >= IDLE_MS).length,
  };
}

/** keepaliveOnce 单局保活观察：A 心跳在线 / B 关心跳（同一局同一参数，只差心跳）。 */
async function keepaliveOnce(tag) {
  const a = await newPlayer(`${tag}-a`); // 心跳在线
  const b = await newPlayer(`${tag}-b`); // 对照：心跳关闭
  await Promise.all([enqueue(a), enqueue(b)]);
  const da = await openDirectRetry(a, HEARTBEAT_MS);
  const db = await openDirectRetry(b, 0); // heartbeatMs=0：显式关闭心跳
  const frameAtJoin = Number(da.join?.currentFrame ?? 0);
  const budgetMs = (MAX_FRAMES - frameAtJoin) * TICK_MS; // 对局剩余寿命（服务端帧上限口径）
  const windowMs = Math.max(1_000, Math.min(SILENCE_MS, budgetMs - 600));
  log(
    `[保活] 双双入局：A 心跳 ${HEARTBEAT_MS}ms / B 心跳关闭（对照）；A currentFrame=${da.join?.currentFrame} ` +
      `B currentFrame=${db.join?.currentFrame}；对局剩余≈${budgetMs}ms → 静默窗口 ${windowMs}ms（${stamp()}）`,
  );
  const silenceAt = await silenceWindow(da, windowMs);
  const actualWindow = Date.now() - silenceAt;
  const { pings, inputs, afterThreshold } = measureSilence(da, silenceAt);
  log(
    `[保活] 静默 ${(actualWindow / 1000).toFixed(1)}s 内只发心跳：A 发出 Ping=${pings} 条、SendFrameInput=${inputs} 条；` +
      `距最后一次输入 ≥${IDLE_MS}ms 后仍收到帧广播 ${afterThreshold} 条；A 状态=${da.session.state()}`,
  );
  const resumed = await resumeAfterSilence(da, silenceAt);
  await observeNaturalEnd(da, db, silenceAt);
  const dDrop = db.stats.failedAt === null ? null : db.stats.failedAt - silenceAt;
  log(
    `[保活] 对照 B（心跳关闭）：${dDrop === null ? '同窗口内未掉线' : `静默 ${(dDrop / 1000).toFixed(1)}s 后被拆流：${db.stats.failedErr?.message}`}` +
      `；B 是否收到结束通知=${db.stats.battleEndAt !== null ? '是' : '否'}`,
  );
  await closeQuiet(da.session, a.client);
  await closeQuiet(db.session, b.client);
  return {
    battleId: da.session.battleId,
    ws: da.session.address,
    frameAtJoin,
    budgetMs,
    windowMs: actualWindow,
    silenceAt,
    pings,
    inputs,
    afterThreshold,
    aState: da.session.state(),
    aOut: da.stats.pushes.some((p) => p.op === OP_OUT),
    aEndedAt: da.stats.battleEndAt,
    aFailedAt: da.stats.failedAt,
    hbFailures: da.stats.hbFailures.length,
    resumed,
    dDrop,
  };
}

/** runKeepalive 保活验收：入局过晚（剩余寿命不足）时重开一局，最多 attempts 次。 */
async function runKeepalive(attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    last = await keepaliveOnce(`keep${i}`);
    if (last.budgetMs >= IDLE_MS + 600 || i === attempts) return last;
    log(`[保活] 本局入局过晚（currentFrame=${last.frameAtJoin}，剩余 ${last.budgetMs}ms < 阈值+余量）：换一局重试`);
  }
  return last;
}

/** reportKeepalive 打印保活验收结论与窗口受限说明。 */
function reportKeepalive(k) {
  const crossed = k.windowMs >= IDLE_MS;
  const survived = k.aFailedAt === null || (k.aEndedAt !== null && k.aEndedAt <= k.aFailedAt);
  const ok =
    k.pings > 0 && k.inputs === 0 && k.aOut === false && k.hbFailures === 0 && survived && (k.afterThreshold > 0 || crossed);
  log(
    `保活验收${ok ? '通过' : '未通过'}：心跳在线玩家静默 ${(k.windowMs / 1000).toFixed(1)}s（只发心跳 ${k.pings} 条、输入 0 条）` +
      `未被判出局；跨过 ${IDLE_MS}ms 空闲阈值=${crossed}（阈值后仍收到帧广播 ${k.afterThreshold} 条）；` +
      `窗口后继续发帧/补帧=${k.resumed ? 'OK' : '未做（对局已自然结算）'}；心跳失败回调=${k.hbFailures} 次`,
  );
  log(
    `对照（关心跳）：${k.dDrop === null ? '同窗口内未掉线' : `静默 ${(k.dDrop / 1000).toFixed(1)}s 后被拆流`}` +
      `——WS 面的空闲判掉线阈值不是 ${IDLE_MS}ms（服务端 websocket.idle_timeout 不配 = 底层默认 120s，` +
      `offline_timeout/3 只用于 kcp/udp 数据报面），故 WS 面无法复现 ~5s 拆流对照。`,
  );
  if (k.windowMs < SILENCE_MS) {
    log(
      `[说明] 静默窗口 ${Math.round(k.windowMs)}ms < 请求的 ${SILENCE_MS}ms：本局入局时 currentFrame=${k.frameAtJoin}，` +
        `剩余≈${k.budgetMs}ms；服务端帧上限 ${MAX_FRAMES} × tick ${TICK_MS}ms = ${(MAX_FRAMES * TICK_MS) / 1000}s` +
        `（battle 硬缺省、无配置项），单局内可观察静默上限小于 8s。`,
    );
  }
  return ok;
}

async function main() {
  log(`=== 跨机直连闭环（TS/ws 经接入层）gateway=${GATEWAY} 起始 ${new Date().toISOString()} ===`);
  const loop = await runClosedLoop();
  log(`闭环通过（TS/ws 经接入层）：battleId=${loop.battleId} 接入层 ws=${loop.ws}`);
  const keep = await runKeepalive();
  const ok = reportKeepalive(keep);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[驱动] 失败:', err?.stack ?? String(err));
  process.exit(2);
});
