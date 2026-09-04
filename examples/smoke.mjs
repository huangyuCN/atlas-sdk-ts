// smoke：atlas-sdk-ts 真连接冒烟脚本（对齐 atlas-sdk-go examples/smoke 的流程与验收口径）。
//
// 形态（node examples/smoke.mjs --form <tcp|ws|udp|dual> ...）：
//   node examples/smoke.mjs --form tcp  --addr 10.10.9.36:9001              # TCP 业务闭环
//   node examples/smoke.mjs --form ws   --addr 10.10.9.36:9002              # WS single 闭环
//   node examples/smoke.mjs --form udp  --addr 10.10.9.36:9004              # UDP 战斗协议通道探针
//   node examples/smoke.mjs --form dual --tcp 10.10.9.36:9001 --ws 10.10.9.36:9002
//   --reconnect-after 3000：演练等待期（配合外层重启 gateway；0 = 不演练）
//
// 网关按用途绑定通道（模板 D6）：TCP/WS=认证协议（业务闭环）；KCP/UDP=战斗协议
// （仅探针，不做业务 Login——会话绑定业务通道）。退出码 0 = 冒烟通过。
// 依赖 dist 产物：先 pnpm build。
import {
  BusinessError,
  HeartbeatOperation,
  isBusinessError,
  WithBackoff,
  WithHeartbeatInterval,
  WithInvokeTimeout,
  WithOnReconnected,
  WithSerializer,
  WithSessionHeartbeat,
  newWSClient,
} from '../dist/index.js';
import { newTCPClient, newUDPClient, newDualClientNode } from '../dist/node.js';
import { ProtobufSerializer } from '../dist/protobuf.js';
import { registry, schemas, newMsg, fromPb } from './gatewayv1.mjs';

// ---- 协议常量与 DTO（与模板 api/gateway/v1 一致；正式 DTO 由 atlas sdk gen 生成）----
const opRegister = '/gateway.v1.GatewayAuth/Register';
const opLogin = '/gateway.v1.GatewayAuth/Login';
const opHeartbeat = '/gateway.v1.GatewayAuth/Heartbeat';
const opJoinBattle = '/gateway.v1.GatewayBattle/JoinBattle';
const SMOKE_PASSWORD = 'pw-123456';


// ---- CLI ----
const arg = (name, dflt = '') => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const form = arg('form', 'tcp');
const addr = arg('addr', '127.0.0.1:9001');
const tcpAddr = arg('tcp', '127.0.0.1:9001');
const wsAddr = arg('ws', '127.0.0.1:9002');
const reconnectAfter = Number(arg('reconnect-after', '0'));
const serializer = arg('serializer', 'json'); // json | protobuf
const account = arg('account', 'smoke-' + Date.now());

// ---- DTO 工厂：按 -serializer 模式返回 plain object（json）或 @bufbuild message（protobuf）----
const isProtobuf = serializer === 'protobuf';

/** 请求 DTO 构造（按编码模式）。 */
function mkReq(reqName, data) {
  if (isProtobuf) {
    return newMsg(schemas[reqName], data);
  }
  return data;
}

/** 从响应取字段：json 返回对象直接取；protobuf 返回原始字节，按 op 的响应
 * schema fromBinary 解码后取字段（SDK invoke 固定 unmarshal(data, null)，protobuf
 * 非自描述返回原样字节，调用方按 schema 解码——与 Go 侧 resp-target 分工对齐）。
 */
function respVal(schemaName, resp, field) {
  if (isProtobuf) {
    const decoded = fromPb(schemas[schemaName], resp);
    return decoded[field];
  }
  return resp ? resp[field] : undefined;
}

const log = (...a) => console.log('[冒烟]', ...a);
log('载荷编码:', serializer);
const fail = (msg) => {
  console.error('[冒烟] 失败:', msg);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 会话状态（重登钩子写回；闭包形态对齐 Go smoke 的指针参数）。 */
const state = { player: '', token: '' };
/** 钩子闭包引用的 client（钩子执行时已赋值；钩子内 Invoke 走 hookBypass 直通）。 */
let client;

/** 一次性信号（重登/重绑钩子完成通知；钩子多次成功触发时幂等）。 */
function signal() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, done: () => resolve() };
}

const commonOpts = [
  WithHeartbeatInterval(5_000),
  WithInvokeTimeout(5_000),
  WithBackoff(200, 3_000),
  ...(isProtobuf ? [WithSerializer(new ProtobufSerializer(registry))] : []),
];

/** 会话心跳配置：闭包携带最新 token/player，未登录时跳过本轮（网关租期 30s，周期 2s）。 */
const sessionHeartbeatOpt = () =>
  WithSessionHeartbeat(2_000, () => {
    if (!state.token) return null;
    return {
      op: opHeartbeat,
      req: mkReq('HeartbeatRequest', {
        token: state.token,
        playerId: state.player,
        ts: isProtobuf ? Date.now() : String(Date.now()),
      }),
    };
  });

/** 会话重登钩子：失败抛错（SDK 视为本次重连未完成，退避重试）。 */
const reloginHook = (done) =>
  WithOnReconnected(async () => {
    const rep = await client.invoke(
      opLogin,
      mkReq('LoginRequest', { playerId: state.player, password: SMOKE_PASSWORD }),
    );
    state.player = respVal('LoginReply', rep, 'playerId');
    state.token = respVal('LoginReply', rep, 'token');
    log('重连后重登成功（新令牌已存）');
    done();
  });

async function registerAndLogin() {
  const reg = await client.invoke(
    opRegister,
    mkReq('RegisterRequest', { account, password: SMOKE_PASSWORD, nickname: '冒烟玩家' }),
  );
  state.player = respVal('RegisterReply', reg, 'playerId');
  log('注册成功 playerId=' + state.player);
  const rep = await client.invoke(
    opLogin,
    mkReq('LoginRequest', { playerId: state.player, password: SMOKE_PASSWORD }),
  );
  state.player = respVal('LoginReply', rep, 'playerId');
  state.token = respVal('LoginReply', rep, 'token');
}

async function businessHeartbeats(n) {
  for (let i = 0; i < n; i++) {
    await client.invoke(
      opHeartbeat,
      mkReq('HeartbeatRequest', {
        token: state.token,
        playerId: state.player,
        ts: isProtobuf ? Date.now() : String(Date.now()),
      }),
    );
    await sleep(200);
  }
}

/** 通道存活探针：Ping 往返成功或业务拒绝均证明往返完成、链路存活；网络类错误 = 未恢复。 */
async function probeAlive() {
  try {
    await client.invoke(HeartbeatOperation, null);
    return true;
  } catch (err) {
    return isBusinessError(err);
  }
}

async function assertConnected(form) {
  await sleep(2_000); // 传输心跳保活观测窗口
  if (client.state() !== 'connected') fail(`最终状态 ${client.state()} ≠ connected（${form} 形态）`);
}

async function waitSignal(sig, what) {
  // 超时分支必须可取消：信号先到后泄漏的 fail() 定时器会在 close 后误触发退出。
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待${what}超时（当前状态 ${client.state()}）`)), 30_000);
  });
  try {
    await Promise.race([sig.promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 重连演练等待期：外层在此期间重启 gateway，SDK 自动重连 + 钩子恢复。 */
async function reconnectDrill(sig, what, after) {
  if (reconnectAfter <= 0) return;
  log(`${reconnectAfter}ms 后请重启 gateway（等待自动重连+${what}）`);
  await sleep(reconnectAfter);
  await waitSignal(sig, what);
  if (after) await after();
}

/** 单通道业务闭环（TCP/WS）：注册 → 登录 → 业务心跳 →（可选）重连演练+重登。 */
async function runSingle(dial, form) {
  const reloginSignal = signal();
  client = await dial([
    ...commonOpts,
    reloginHook(reloginSignal.done),
    sessionHeartbeatOpt(),
  ]);
  try {
    await registerAndLogin();
    log(`登录成功 playerId=${state.player} token 已存`);
    await businessHeartbeats(3);
    log('业务心跳 3 次往返 OK');
    await reconnectDrill(reloginSignal, '重登', async () => {
      await businessHeartbeats(3);
      log('重连后业务心跳 3 次往返 OK');
    });
    await assertConnected(form);
    console.log(`冒烟通过（真连接闭环：注册/登录/业务心跳/传输心跳/自动重连+重登，${form}）`);
  } finally {
    await client.close();
  }
}

/** 战斗协议通道探针（UDP 等）：拨号 → Ping/业务拒绝探针 →（可选）死链重拨演练。 */
async function runBattleChannel(form) {
  client = await newUDPClient(addr, commonOpts);
  try {
    if (!(await probeAlive())) fail(`${form} 通道往返探针失败`);
    log(`${form} 通道往返探针 OK`);
    // 战斗 payload 编解码验证（protobuf 模式）：发 JoinBattle（伪造 token）——
    // 服务端按 ver=2 分派 codec 解码后因会话无效回业务拒绝（BusinessError）即
    // 证明 payload 编解码正确（协议错误/解码失败才说明编解码问题）。
    if (isProtobuf) {
      try {
        await client.invoke(
          opJoinBattle,
          mkReq('JoinBattleRequest', { token: 'no-token', playerId: 'none', battleId: 'b1' }),
        );
        fail(`${form} JoinBattle 应被拒绝（伪造 token），却成功`);
      } catch (err) {
        if (err instanceof BusinessError) {
          log(`${form} JoinBattle 业务拒绝（protobuf 编码解码正确）`);
        } else {
          fail(`${form} JoinBattle 收到非业务错误 ${err?.message ?? err}（payload 编解码可能失败）`);
        }
      }
    }
    if (reconnectAfter > 0) {
      log(`${reconnectAfter}ms 后请重启 gateway（等待死链重拨）`);
      await sleep(reconnectAfter);
      await waitForAlive(form);
      log('重拨后往返探针 OK');
    }
    await assertConnected(form);
    console.log(`冒烟通过（${form} 战斗协议通道：拨号/传输心跳保活/自动重拨）`);
  } finally {
    await client.close();
  }
}

async function waitForAlive(form) {
  const deadline = Date.now() + 30_000;
  while (!(await probeAlive())) {
    if (Date.now() > deadline) fail(`等待${form}重拨恢复超时（当前状态 ${client.state()}）`);
    await sleep(500);
  }
}

/** dual 双通道闭环（业务 TCP + 战斗 WS）：独立重连/重登/重绑 + 链式编排。 */
async function runDual() {
  const reloginSignal = signal();
  const rebindSignal = signal();
  let joinCalls = 0;
  client = await newDualClientNode(
    {
      addr: tcpAddr,
      opts: [reloginHook(reloginSignal.done), sessionHeartbeatOpt()],
    },
    {
      addr: wsAddr,
      kind: 'ws',
      path: '/ws',
      opts: [
        WithOnReconnected(async () => {
          // 战斗通道重绑定（模板 JoinBattle 语义的冒烟替身）：战斗通道传输心跳
          // 往返即证明重连后可用；战斗通道不做业务 Login（会话绑定业务通道）。
          joinCalls += 1;
          await client.channel('battle').invoke(HeartbeatOperation, null);
          log('战斗通道重连后重绑定成功');
          rebindSignal.done();
        }),
      ],
    },
    commonOpts,
  );
  try {
    await registerAndLogin();
    log('业务通道登录成功 playerId=' + state.player);
    await client.channel('battle').invoke(HeartbeatOperation, null);
    log('战斗通道（ws）传输心跳往返 OK');
    await businessHeartbeats(3);
    log('业务心跳 3 次往返 OK');
    if (reconnectAfter > 0) {
      log(`${reconnectAfter}ms 后请重启 gateway（等待双通道自动重连+重登/重绑定）`);
      await sleep(reconnectAfter);
      await waitSignal(reloginSignal, '业务重登');
      await waitSignal(rebindSignal, '战斗重绑定');
      await businessHeartbeats(3);
      log('重连后业务心跳 3 次往返 OK');
    }
    await assertConnected('dual');
    console.log(`冒烟通过（dual 双通道闭环：业务TCP/战斗ws 独立重连+重登+重绑定，重绑 ${joinCalls} 次）`);
  } finally {
    await client.close();
  }
}

async function main() {
  switch (form) {
    case 'tcp':
      await runSingle((opts) => newTCPClient(addr, opts), 'tcp');
      break;
    case 'ws':
      await runSingle((opts) => newWSClient(addr, opts), 'ws');
      break;
    case 'udp':
      await runBattleChannel('udp');
      break;
    case 'dual':
      await runDual();
      break;
    default:
      fail(`未知形态 ${form}（tcp|ws|udp|dual）`);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
