// 战斗直连的公共契约：状态词汇、会话接口与配置（选项 + 默认值解析）。
// session.ts 只管连接生命周期，契约面拆到这里控制单文件规模；
// 默认值与内核（Channel）同口径，便于两处行为一致。
import { MAX_BODY_SIZE } from '../frame/constants.js';
import type { InvokeOption } from '../client/options.js';
import { defaultSerializer, type Serializer } from '../client/serializer.js';
import type { WebSocketFactory } from '../transport/ws.js';
import type { BattleSessionStats } from './stats.js';

/** DEFAULT_HEARTBEAT_MS 直连保活心跳缺省周期（ms）：严格小于 battle 侧空闲读超时
 *  offline_timeout/3（缺省 15s/3 = 5s），留出一次丢帧与调度抖动的余量。 */
export const DEFAULT_HEARTBEAT_MS = 2_000;

/** DEFAULT_DRAIN_MS 对局结束后的收尾窗口缺省值（ms）。取值依据（服务端已就绪的语义）：
 *  结算关闭前的有界重投（EndRetries=2）与最后一帧都在同一 tick 内发出，一个 RTT 即可到达；
 *  留 2s ≈ 一个心跳周期，足以覆盖调度抖动与慢链路；又远小于留档 TTL（票据有效期 + 掉线窗口），
 *  不会让已结束的连接长期悬挂。流式面（WS/KCP）服务端会先关，客户端通常先收到断开事件，
 *  本窗口主要兜底数据报面（没有关闭事件）与断开信号丢失的情形。 */
export const DEFAULT_DRAIN_MS = 2_000;

/** BattleSessionState 战斗直连会话状态。两个终态按「**有没有结算可展示**」分界：
 *  'ended' = 对局**正常结束**（收到结束通知或 BATTLE_ENDED 业务拒绝）——停发，收尾窗口内
 *  继续读结果，窗口到点释放连接，结算数据可展示；
 *  'failed' = **无结算的终态拒绝**（BATTLE_NOT_FOUND / BATTLE_FULL / FRAME_TARGET_MISMATCH
 *  等不可重试拒绝，或协议致命/重连窗口用尽）——停发并释放连接，经 onFailed 上报，
 *  此时**没有结算可展示**（上层不该去取结算数据）。 */
export type BattleSessionState = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed' | 'closed';

/** ProbeSpec 保活探针（心跳）：op 与载荷由调用方用游戏协议包构造，SDK 只按时发送、
 *  按拒绝分类处置。**未配置即不发任何字节**——不裸发现空载荷探针（服务端会按目标一致性拒绝）。 */
export interface ProbeSpec {
  /** 探针 op（Tell 语义，服务端不回业务回执；SDK 等帧引擎必回的空信封以捞出可判定失败）。 */
  readonly op: string;
  /** 探针请求载荷（按本会话的序列化器编码；每拍复用同一份，缺省为空载荷）。 */
  readonly req?: unknown;
}

/** ReplayStep 重连后要重放的一步（通常是「入局」与「按 last_seen_frame 补帧」）。 */
export interface ReplayStep {
  /** 重放请求的 op 名（协议寻址键，取值见 opkeys.ts 的 OP_* 常量）。 */
  readonly op: string;
  /** 按当前补帧基准生成请求载荷（游戏侧用协议包构造；缺省表示空载荷）。 */
  readonly req?: (lastSeenFrame: number) => unknown;
}

/** BattleSessionOptions 直连会话配置（全部可选，缺省即生产默认值）。 */
export interface BattleSessionOptions {
  /** 升级路径（默认 '/'，对齐 battle 帧面 WS 服务端默认挂载路径；接入层原样转发升级请求）。 */
  path?: string;
  /** WS 工厂（宿主注入；默认全局 WebSocket，浏览器 / Cocos JSB / Node 22+）。 */
  wsFactory?: WebSocketFactory;
  /** 升级握手超时（默认 10s）。 */
  openTimeoutMs?: number;
  /** 请求默认超时（默认 10s；可 per-call WithRequestTimeout 覆盖）。 */
  invokeTimeoutMs?: number;
  /** 单帧 body 上限（默认协议上限，需与服务端一致）。 */
  maxBodySize?: number;
  /** 载荷序列化插槽（默认 JSON/protojson，ver=1）。 */
  serializer?: Serializer;
  /** 保活探针（缺省不配置 = 心跳循环不启动、零写出）：内容由游戏协议包构造。 */
  probe?: ProbeSpec;
  /** 重连后的重放步骤（缺省空 = 重连不重放任何业务 op）：入局/补帧的载荷由这一步生成。 */
  replay?: readonly ReplayStep[];
  /** 意外断线自动退避重连（默认 true）。 */
  autoReconnect?: boolean;
  /** 重连窗口（默认 15s，对齐 battle 侧 offline_timeout 默认值）：窗口内退避重试，
   *  窗口用尽即判定接入层拒连（**不无限重试**，避免对失效票刷连接）。 */
  reconnectWindowMs?: number;
  /** 重连退避 base（默认 500ms，带 ±20% 抖动）。 */
  backoffBaseMs?: number;
  /** 重连退避上限（默认 30s）。 */
  backoffMaxMs?: number;
  /** 直连保活心跳周期（默认 DEFAULT_HEARTBEAT_MS = 2000ms；显式 0 关闭）。
   *  必须严格小于 battle 侧空闲读超时 = offline_timeout/3（缺省 15s → 5s）：
   *  无输入期间由心跳帧刷新帧面活跃，超时即被判拆流/掉线。 */
  heartbeatMs?: number;
  /** 心跳失败回调（**只上报不终止**：写失败/序列化失败不改会话状态、不触发重连）。 */
  onHeartbeatFailed?: (err: unknown) => void;
  /** 收尾窗口（默认 DEFAULT_DRAIN_MS = 2000ms；显式 0 = 收到结束通知即释放连接）。
   *  收到结束通知/ BATTLE_ENDED 后**立刻停发**（业务帧 + 心跳），但连接保留本窗口以读完
   *  服务端在关闭前重投/补齐的结果推送；窗口到点（或服务端先关）即释放。 */
  drainMs?: number;
  /** 帧广播回调（原始载荷 + 帧头载荷编码版本）：**ver=2 需自行解码**——载荷是 protobuf
   *  二进制，由游戏侧生成包按 `version` 解码，SDK 只交字节与版本、不预解。 */
  onFrame?: (payload: Uint8Array, version: number) => void;
  /** 战斗结束回调（原始载荷 + 版本）。**同一局只触发一次**：服务端结算关闭前的有界重投
   *  （EndRetries=2）与重连补投（每玩家最多 5 次）都会让同一份通知重复到达，重复副本不再
   *  回调（**载荷逐字一致**；若出现不一致副本，以先到者为准——结算不可改判），且**补投
   *  副本不从任何出口出去**（不经 onPush；与 Go/C# 同口径，首投即唯一可观测量）。
   *
   *  **空载荷不触发**（也不进终态、不经 onPush 分发）：零字节的结束通知**不构成结束信号**
   *  ——这是跨 SDK 统一契约（Go `direct/ended.go` 的 `noteEndNotify`、C# `NoteEndNotify`
   *  都以载荷长度为零提前返回，三语言必须同口径）。空载荷同样不占用「首投」名额：随后
   *  到达的非空首投照常进终态并回调一次，不会被当补投副本丢弃。 */
  onBattleEnd?: (payload: Uint8Array, version: number) => void;
  /** 任意战斗域推送回调（op 原样透传；帧广播/结束也会走这里）。payload 与 version 同样
   *  **原样透传**：ver=2 的二进制需调用方自行解码。唯一的例外是**结束通知**：只有首投会
   *  从这里出去一次，空载荷与补投副本都不分发（与 Go/C# 同口径，见 onBattleEnd）。 */
  onPush?: (op: string, payload: Uint8Array, version: number) => void;
  /** 重连成功回调（重新升级并按 `replay` 重放之后）。 */
  onReconnected?: () => void | Promise<void>;
  /** 会话失败回调（自动重连窗口用尽 / 协议致命）。 */
  onFailed?: (err: unknown) => void;
  /** 帧号提取钩子（重连补帧的 last_seen_frame 基准）：**所有载荷编码都只认本钩子**——
   *  帧广播的字段布局属游戏协议，SDK 不持类型、不猜编码。返回帧号；**取不到返回 null**
   *  ——不推进补帧基准、也不报错（与 Go 的 FrameNumberFunc 同口径）。未注入时一律不推进
   *  （`lastSeenFrame()` 恒 0，补帧退化为全量）。 */
  frameNumberOf?: (payload: Uint8Array, version: number) => number | null;
}

/** BattleSession 一条票据绑定的战斗直连会话（战斗 op 全部走直连，不再经网关）。 */
export interface BattleSession {
  /** 对局 ID（成局推送的信息字段）。 */
  readonly matchId: string;
  /** 战斗 ID（入局/补帧请求的客体寻址字段；消息类型属游戏协议包）。 */
  readonly battleId: string;
  /** 实际拨号的接入层 WS 面地址（host:port，只来自本局推送）。 */
  readonly address: string;
  /** 当前状态（'ended' 为终态：心跳与业务发帧已停，连接在收尾窗口到点后释放）。 */
  state(): BattleSessionState;
  /** 发一条业务 op 并等回执：op 与载荷由调用方给出（通常来自游戏协议包的生成 DTO 与
   *  op 常量），SDK 只做编码、写线、匹配回执与错误归一，**不持有任何游戏域消息类型**。
   *  未就绪（未建连/重连恢复中/已关闭）即报错，不排队；业务拒绝抛 BusinessError。 */
  invoke(op: string, req?: unknown, ...opts: InvokeOption[]): Promise<unknown>;
  /** ended 对局是否已结束（终态判定）：收到结束通知或 BATTLE_ENDED 业务拒绝后**永久为真**
   *  ——即便之后 close()（state 转 'closed'）或连接被回收，也能判定「这一局是打完了」。
   *  为真时一切上发（invoke 的业务 op / 心跳 / 重连）都被本地以 BATTLE_ENDED 拒绝，
   *  不写线。**语义分界**：ended ⇒ 有结算可展示；无结算的终态拒绝
   *  （对局不存在/已满/目标不一致）走 state()='failed' + onFailed，ended() 保持 false。 */
  ended(): boolean;
  /** 已见帧号（帧广播自动推进；重连补帧的 last_seen_frame）。 */
  lastSeenFrame(): number;
  /** 上报已见帧号（调用方自解帧广播载荷时用；只前进不后退）。 */
  noteFrame(frameId: number): void;
  /** 重新升级（票仍在 TTL 内）+ 按 `replay` 配置的步骤重放；已连接时幂等。 */
  reconnect(): Promise<void>;
  /** 关闭会话（幂等；不再重连）。 */
  close(): Promise<void>;
  /** 取只读运行统计快照（重连 / 握手（拨号）/ 心跳失败计数；评审 P1-4 可观测）：
   *  每次调用返回**新对象**（冻结），调用方改它不影响会话内部计数。终态两族分开计：
   *  endedRejects（对局正常结束，有结算）/ fatalRejects（无结算的终态拒绝）。 */
  stats(): BattleSessionStats;
}

/** Settings 会话配置全集（BattleSessionOptions 应用默认值之后）。 */
export interface Settings {
  path: string;
  wsFactory: WebSocketFactory | undefined;
  openTimeoutMs: number;
  invokeTimeoutMs: number;
  maxBodySize: number;
  serializer: Serializer;
  probe: ProbeSpec | undefined;
  replay: readonly ReplayStep[];
  autoReconnect: boolean;
  reconnectWindowMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  heartbeatMs: number;
  drainMs: number;
  onFrame: BattleSessionOptions['onFrame'];
  onBattleEnd: BattleSessionOptions['onBattleEnd'];
  onPush: BattleSessionOptions['onPush'];
  onReconnected: BattleSessionOptions['onReconnected'];
  onFailed: BattleSessionOptions['onFailed'];
  onHeartbeatFailed: BattleSessionOptions['onHeartbeatFailed'];
  frameNumberOf: BattleSessionOptions['frameNumberOf'];
}

/** resolveSettings 应用默认值（探针/重放缺省不配置：不内建任何游戏域消息）。 */
export function resolveSettings(opts: BattleSessionOptions): Settings {
  return {
    path: opts.path ?? '/',
    wsFactory: opts.wsFactory,
    openTimeoutMs: opts.openTimeoutMs ?? 10_000,
    invokeTimeoutMs: opts.invokeTimeoutMs ?? 10_000,
    maxBodySize: opts.maxBodySize ?? MAX_BODY_SIZE,
    serializer: opts.serializer ?? defaultSerializer,
    probe: opts.probe,
    replay: opts.replay ?? [],
    autoReconnect: opts.autoReconnect ?? true,
    reconnectWindowMs: opts.reconnectWindowMs ?? 15_000,
    backoffBaseMs: opts.backoffBaseMs ?? 500,
    backoffMaxMs: opts.backoffMaxMs ?? 30_000,
    heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    drainMs: opts.drainMs ?? DEFAULT_DRAIN_MS,
    onFrame: opts.onFrame,
    onBattleEnd: opts.onBattleEnd,
    onPush: opts.onPush,
    onReconnected: opts.onReconnected,
    onFailed: opts.onFailed,
    onHeartbeatFailed: opts.onHeartbeatFailed,
    frameNumberOf: opts.frameNumberOf,
  };
}
