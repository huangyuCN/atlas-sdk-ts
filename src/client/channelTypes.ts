// 通道的类型词汇与常量（从 channel.ts 拆出，控制单文件规模）：连接角色、状态、
// 传输心跳参数、代（generation）标识与请求编排的内部载体。本模块只放**类型与常量**，
// 不含任何行为——连接本体在 channel.ts，协作模块（readloop/heartbeat/reconnect）与
// 编排层（client.ts）从这里取词汇。
import type { Status } from '../frame/status.js';
import type { NetworkError, ProtocolError, TimeoutError } from './errors.js';
import type { InvokeOptions } from './options.js';
import type { ChannelTransport } from './transport.js';

/** 通道角色：业务 / 战斗（dual 形态）。 */
export const Kind = {
  Business: 'business',
  Battle: 'battle',
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** 通道连接状态。 */
export type ChannelState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** 传输心跳死链判定阈值：连续失败次数（网络类失败才计数，业务拒绝不计）。 */
export const HEARTBEAT_FAILURES = 3;

/** 传输保活心跳 operation（服务端引擎内置空响应 handler）。 */
export const HeartbeatOperation = '/atlas.internal.Heartbeat/Ping';

/** 一代连接：每次拨号成功分配一个 Generation；epoch 单调递增隔离新旧代。 */
export interface Generation {
  readonly epoch: number;
  readonly transport: ChannelTransport;
  /** 读循环退出（连接死亡）时 settle。 */
  readonly done: Promise<void>;
  /** 内部：resolve done（onGenerationDead 调用）。 */
  readonly finish: () => void;
}

/** 待结算请求登记项（in-flight 表的值；timer 负责超时兜底）。 */
export interface PendingEntry {
  settle: (outcome: PendingOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一次请求的结算结果（恰一次：迟到结果由 settleInflight 查表丢弃）。 */
export type PendingOutcome =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'status'; status: Status }
  | { kind: 'error'; error: AtlasErrorKind };

/** 重连期间排队的请求（幂等键在入口一次决定，drain 重发复用同一 ID）。 */
export interface QueuedRequest {
  op: string;
  req: unknown;
  io: InvokeOptions;
  /** 幂等键：invoke 入口一次决定，drain 重发复用同一 ID（服务端去重窗口内不重复执行）。 */
  requestId: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 结算错误的三分类（业务拒绝不进这里：它以 Status 结算后转 BusinessError）。 */
export type AtlasErrorKind = NetworkError | TimeoutError | ProtocolError;
