// battle-load：多连接战斗压测客户端（TS 客户端口径）。
//
// 与 Go 侧 lt-driver 同口径，但用 **TS SDK** 跑：注册/登录 → 入队匹配 → 拿票经接入层直连 →
// 按 pps 发帧输入 → 按 probe 间隔测 SyncFrames 往返。用于验证 TS 客户端在真实游戏负载下的表现。
//
// 能力边界（SDK 现状）：TS 的 battle 会话只实现了 **WS** 面（src/battle/session.ts 只导入
// dialWebSocket），UDP/KCP 的直连客户端尚未落地，故本工具只压 ws。
//
// 用法：
//   node examples/battle-load.mjs --players 300 --pps 15 --duration 60000 \
//     --gateway 10.10.1.23:9001 --edge 10.10.1.23:7100
// 输出：一行 SUMMARY JSON（与 Go 驱动同名段，便于横向对比）。
import {
  CLIENT_VERSION,
  OP_JOIN_BATTLE,
  OP_SEND_FRAME_INPUT,
  OP_SYNC_FRAMES,
  isEdgeRejected,
  newWSClient,
  openBattleSession,
  parseDirectPlan,
  WithInvokeTimeout,
} from '../dist/index.js';
import { matchPushOps, playerOps } from './gamev1.mjs';
import { sessionOps } from './gatewayv1.mjs';

const PASSWORD = 'pw';
const RULESET = 'casual';

/** parseArgs 解析 --k v 形式的参数（缺省值见 DEFAULT）。 */
function parseArgs(argv) {
  const out = { ...DEFAULT };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (!(k in out)) continue;
    out[k] = typeof out[k] === 'number' ? Number(v) : v;
  }
  return out;
}

const DEFAULT = {
  players: 100,
  pps: 15,
  probe: 1000,
  duration: 60_000,
  conc: 32,
  gateway: '10.10.1.23:9001',
  edge: '10.10.1.23:7100',
  ruleset: RULESET,
};

const args = parseArgs(process.argv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

/** parallelFor 以固定并发度跑 n 个任务（下标顺序无关）。 */
async function parallelFor(n, conc, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(conc, n) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      await fn(i);
    }
  });
  await Promise.all(workers);
}

/** registerAndLogin 注册一个全新账号并登录（账号名带纳秒，避免重名）。 */
async function registerAndLogin(client, tag) {
  let account = `tsload-${tag}-${Date.now()}`;
  let reg;
  for (let i = 0; ; i++) {
    try {
      reg = await client.invoke(sessionOps.register, { account, password: PASSWORD, nickname: account });
      break;
    } catch (err) {
      if (err?.reason === 'PLAYER_ALREADY_EXISTS' && i < 5) {
        account = `tsload-${tag}-${Date.now()}-${i}`;
        continue;
      }
      throw err;
    }
  }
  await client.invoke(sessionOps.login, {
    playerId: reg.playerId,
    password: PASSWORD,
    clientVersion: CLIENT_VERSION,
    clientEnd: 'ts-load',
  });
  return reg.playerId;
}

/** newPlayer 建一条业务链路（网关 WS）并完成注册登录。 */
async function newPlayer(tag) {
  const client = await newWSClient(args.gateway, [WithInvokeTimeout(8000)]);
  const playerId = await registerAndLogin(client, tag);
  return { tag, client, playerId };
}

/** enqueue 订阅成局推送后入队，返回该玩家的直连计划（票 + 接入层地址）。 */
async function enqueue(player) {
  const started = new Promise((resolve, reject) => {
    player.client.on(matchPushOps.matchStartedNotify, (_op, payload) => resolve(payload));
    player.client.on(matchPushOps.matchFailedNotify, (_op, payload) => {
      reject(new Error('成局失败推送: ' + new TextDecoder().decode(payload)));
    });
    setTimeout(() => reject(new Error('成局通知超时')), 60_000);
  });
  await player.client.invoke(playerOps.enterMatchQueue, { ruleset: args.ruleset });
  player.plan = parseDirectPlan(await started);
}

/** openDirect 经接入层直连并显式入局；接入层拒连（后端未就绪）按退避重试。 */
async function openDirect(player) {
  const stats = { frames: 0, failed: null };
  let session;
  for (let i = 1; ; i++) {
    try {
      session = await openBattleSession(player.plan, {
        heartbeatMs: 3000,
        autoReconnect: false,
        onFrame: () => {
          stats.frames += 1;
        },
        onFailed: (err) => {
          stats.failed = err;
        },
      });
      await session.invoke(OP_JOIN_BATTLE, { battleId: player.plan.battleId });
      return { session, stats };
    } catch (err) {
      if (!isEdgeRejected(err) || i >= 10) throw err;
      await sleep(250);
    }
  }
}

/** percentile 取分位数（样本已排序）。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** main 跑一轮压测并打印 SUMMARY。 */
async function main() {
  const t0 = Date.now();
  log(`=== TS 压测 players=${args.players} pps=${args.pps} duration=${args.duration}ms ===`);

  const players = [];
  let regFail = 0;
  await parallelFor(args.players, args.conc, async (i) => {
    try {
      players.push(await newPlayer(`p${i}`));
    } catch (err) {
      regFail += 1;
      if (regFail <= 3) log(`[注册失败] p${i}: ${err?.message ?? err}`);
    }
  });
  log(`[阶段] 注册登录完成 ${players.length}/${args.players}（失败 ${regFail}），+${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await Promise.all(players.map((p) => enqueue(p).catch((err) => log(`[入队失败] ${p.tag}: ${err.message}`))));
  const matched = players.filter((p) => p.plan);
  log(`[阶段] 成局 ${matched.length}，+${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const sessions = [];
  let connFail = 0;
  await parallelFor(matched.length, args.conc, async (i) => {
    try {
      const r = await openDirect(matched[i]);
      sessions.push({ player: matched[i], ...r });
    } catch (err) {
      connFail += 1;
      if (connFail <= 3) log(`[直连失败] ${matched[i].tag}: ${err?.message ?? err}`);
    }
  });
  log(`[阶段] 直连入局 ${sessions.length}/${matched.length}（失败 ${connFail}），+${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rtt = [];
  let probeErr = 0;
  let inputErr = 0;
  let inputs = 0;
  const inputEvery = Math.max(1, Math.round(1000 / args.pps));
  const startedAt = Date.now();
  const endsAt = startedAt + args.duration;

  const loops = sessions.map(async ({ session }) => {
    let frameId = 1;
    let lastProbe = 0;
    while (Date.now() < endsAt) {
      const now = Date.now();
      if (now - lastProbe >= args.probe) {
        lastProbe = now;
        try {
          const t = process.hrtime.bigint();
          await session.invoke(OP_SYNC_FRAMES, {
            battleId: session.battleId,
            lastSeenFrame: String(Math.max(1, frameId - 1)),
          });
          rtt.push(Number(process.hrtime.bigint() - t) / 1e6);
        } catch {
          probeErr += 1;
        }
      }
      try {
        await session.invoke(OP_SEND_FRAME_INPUT, {
          battleId: session.battleId,
          input: { frameId: String(frameId++), payload: 'AA==' },
        });
        inputs += 1;
      } catch {
        inputErr += 1;
      }
      await sleep(inputEvery);
    }
  });
  await Promise.all(loops);

  const rttSorted = rtt.slice().sort((a, b) => a - b);
  const elapsed = (Date.now() - startedAt) / 1000;
  const summary = {
    client: 'ts',
    transport: 'ws',
    transport_note: 'TS SDK 的战斗直连只实现 WS（UDP/KCP 的 TS 直连客户端尚未落地）',
    players_requested: args.players,
    players_registered: players.length,
    players_matched: matched.length,
    connections_established: sessions.length,
    register_failed: regFail,
    connect_failed: connFail,
    duration_s: Number(elapsed.toFixed(1)),
    input_pps: Number((inputs / elapsed).toFixed(1)),
    inputs_sent: inputs,
    input_errors: inputErr,
    probe_errors: probeErr,
    probe_ok: rttSorted.length,
    probe_rtt_ms: {
      count: rttSorted.length,
      p50_ms: percentile(rttSorted, 0.5),
      p95_ms: percentile(rttSorted, 0.95),
      p99_ms: percentile(rttSorted, 0.99),
      max_ms: rttSorted.length ? rttSorted[rttSorted.length - 1] : 0,
    },
    frames_received: sessions.reduce((a, s) => a + s.stats.frames, 0),
    session_failed: sessions.filter((s) => s.stats.failed).length,
    process_rss_mb: Number((process.memoryUsage().rss / 1048576).toFixed(0)),
    node: process.version,
  };
  console.log('SUMMARY ' + JSON.stringify(summary));
  await Promise.allSettled(sessions.map((s) => s.session.close()));
  await Promise.allSettled(players.map((p) => p.client.close()));
  process.exit(0);
}

main().catch((err) => {
  console.error('[压测] 失败:', err?.stack ?? String(err));
  process.exit(2);
});
