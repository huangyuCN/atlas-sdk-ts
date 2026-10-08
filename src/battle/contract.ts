// 战斗直连的公共契约：状态词汇、会话接口与配置（选项 + 默认值解析）。
// session.ts 只管连接生命周期，契约面拆到这里控制单文件规模；
// 默认值与内核（Channel）同口径，便于两处行为一致。
import { MAX_BODY_SIZE } from '../frame/constants.js';
import type { InvokeOption } from '../client/options.js';
import { defaultSerializer, type Serializer } from '../client/serializer.js';
import type { WebSocketFactory } from '../transport/ws.js';
import { DEFAULT_BATTLE_OPS, type BattleOpSet } from './ops.js';

/** DEFAULT_HEARTBEAT_MS 直连保活心跳缺省周期（ms）：严格小于 battle 侧空闲读超时
 *  offline_timeout/3（缺省 15s/3 = 5s），留出一次丢帧与调度抖动的余量。 */
export const DEFAULT_HEARTBEAT_MS = 2_000;

/** DEFAULT_DRAIN_MS 对局结束后的收尾窗口缺省值（ms）。取值依据（服务端已就绪的语义）：
 *  结算关闭前的有界重投（EndRetries=2）与最后一帧都在同一 tick 内发出，一个 RTT 即可到达；
 *  留 2s ≈ 一个心跳周期，足以覆盖调度抖动与慢链路；又远小于留档 TTL（票据有效期 + 掉线窗口），
 *  不会让已结束的连接长期悬挂。流式面（WS/KCP）服务端会先关，客户端通常先收到断开事件，
 *  本窗口主要兜底数据报面（没有关闭事件）与断开信号丢失的情形。 */
export const DEFAULT_DRAIN_MS = 2_000;

/** BattleSessionState 战斗直连会话状态。'ended' 是**终态**：对局已结束（收到结束通知或
 *  BATTLE_ENDED 业务拒绝）——心跳与业务发帧全部停止，连接在收尾窗口到点后释放。 */
export type BattleSessionState = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed' | 'closed';

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
  /** 打开后自动 JoinBattle（默认 true）。 */
  autoJoin?: boolean;
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
  /** 战斗 op / 推送 op 名覆盖（默认 battle.v1 契约，见 ops.ts）。 */
  ops?: Partial<BattleOpSet>;
  /** 帧广播回调（原始载荷 + 帧头载荷编码版本；ver=2 需生成 DTO 解码）。 */
  onFrame?: (payload: Uint8Array, version: number) => void;
  /** 战斗结束回调（原始载荷 + 版本）。**同一局只触发一次**：服务端结算关闭前的有界重投
   *  （EndRetries=2）与重连补投（每玩家最多 5 次）都会让同一份通知重复到达，重复副本不再
   *  回调（**载荷逐字一致**；若出现不一致副本，以先到者为准——结算不可改判）。重复副本仍会
   *  经 onPush 透传，需要逐份留档/上报的调用方请在那条通道上做。 */
  onBattleEnd?: (payload: Uint8Array, version: number) => void;
  /** 任意战斗域推送回调（op 原样透传；帧广播/结束也会走这里）。 */
  onPush?: (op: string, payload: Uint8Array, version: number) => void;
  /** 重连成功回调（重新 JoinBattle + SyncFrames 补帧之后）。 */
  onReconnected?: () => void | Promise<void>;
  /** 会话失败回调（自动重连窗口用尽 / 协议致命）。 */
  onFailed?: (err: unknown) => void;
  /** 帧号提取（重连时 SyncFrames(last_seen_frame) 用）：默认从 ver=1（protojson）的
   *  `frame.frameId` 提取；ver=2 二进制非自描述，需调用方提供本钩子。 */
  frameNumberOf?: (payload: Uint8Array, version: number) => number;
}

/** BattleSession 一条票据绑定的战斗直连会话（战斗 op 全部走直连，不再经网关）。 */
export interface BattleSession {
  /** 对局 ID（成局推送的信息字段）。 */
  readonly matchId: string;
  /** 战斗 ID（JoinBattle/SyncFrames 的客体寻址字段）。 */
  readonly battleId: string;
  /** 实际拨号的接入层 WS 面地址（host:port，只来自本局推送）。 */
  readonly address: string;
  /** 当前状态（'ended' 为终态：心跳与业务发帧已停，连接在收尾窗口到点后释放）。 */
  state(): BattleSessionState;
  /** ended 对局是否已结束（终态判定）：收到结束通知或 BATTLE_ENDED 业务拒绝后**永久为真**
   *  ——即便之后 close()（state 转 'closed'）或连接被回收，也能判定「这一局是打完了」。
   *  为真时一切上发（帧输入 / SyncFrames / JoinBattle / 心跳 / 重连）都被本地以
   *  BATTLE_ENDED 拒绝，不写线。 */
  ended(): boolean;
  /** 已见帧号（帧广播自动推进；重连补帧的 last_seen_frame）。 */
  lastSeenFrame(): number;
  /** 上报已见帧号（调用方自解帧广播载荷时用；只前进不后退）。 */
  noteFrame(frameId: number): void;
  /** 入局（默认请求体 {battleId}；成功后标记为已入局，重连会自动重放）。 */
  joinBattle(req?: unknown, ...opts: InvokeOption[]): Promise<unknown>;
  /** 上行帧输入（默认补 battleId）。 */
  sendFrameInput(req?: unknown, ...opts: InvokeOption[]): Promise<unknown>;
  /** 补帧：按 last_seen_frame 拉缺失帧（缺省用本会话记录的已见帧号）。 */
  syncFrames(lastSeenFrame?: number, ...opts: InvokeOption[]): Promise<unknown>;
  /** 重新升级（票仍在 TTL 内）+ 重新 JoinBattle/SyncFrames；已连接时幂等。 */
  reconnect(): Promise<void>;
  /** 关闭会话（幂等；不再重连）。 */
  close(): Promise<void>;
}

/** Settings 会话配置全集（BattleSessionOptions 应用默认值之后）。 */
export interface Settings {
  path: string;
  wsFactory: WebSocketFactory | undefined;
  openTimeoutMs: number;
  invokeTimeoutMs: number;
  maxBodySize: number;
  serializer: Serializer;
  autoJoin: boolean;
  autoReconnect: boolean;
  reconnectWindowMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  heartbeatMs: number;
  drainMs: number;
  ops: BattleOpSet;
  onFrame: BattleSessionOptions['onFrame'];
  onBattleEnd: BattleSessionOptions['onBattleEnd'];
  onPush: BattleSessionOptions['onPush'];
  onReconnected: BattleSessionOptions['onReconnected'];
  onFailed: BattleSessionOptions['onFailed'];
  onHeartbeatFailed: BattleSessionOptions['onHeartbeatFailed'];
  frameNumberOf: BattleSessionOptions['frameNumberOf'];
}

/** resolveSettings 应用默认值（op 名默认 battle.v1 契约，可整体覆盖单项）。 */
export function resolveSettings(opts: BattleSessionOptions): Settings {
  return {
    path: opts.path ?? '/',
    wsFactory: opts.wsFactory,
    openTimeoutMs: opts.openTimeoutMs ?? 10_000,
    invokeTimeoutMs: opts.invokeTimeoutMs ?? 10_000,
    maxBodySize: opts.maxBodySize ?? MAX_BODY_SIZE,
    serializer: opts.serializer ?? defaultSerializer,
    autoJoin: opts.autoJoin ?? true,
    autoReconnect: opts.autoReconnect ?? true,
    reconnectWindowMs: opts.reconnectWindowMs ?? 15_000,
    backoffBaseMs: opts.backoffBaseMs ?? 500,
    backoffMaxMs: opts.backoffMaxMs ?? 30_000,
    heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    drainMs: opts.drainMs ?? DEFAULT_DRAIN_MS,
    ops: { ...DEFAULT_BATTLE_OPS, ...(opts.ops ?? {}) },
    onFrame: opts.onFrame,
    onBattleEnd: opts.onBattleEnd,
    onPush: opts.onPush,
    onReconnected: opts.onReconnected,
    onFailed: opts.onFailed,
    onHeartbeatFailed: opts.onHeartbeatFailed,
    frameNumberOf: opts.frameNumberOf,
  };
}
