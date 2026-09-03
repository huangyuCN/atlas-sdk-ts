// 配置项：函数式 Option（对齐 Go 侧 Option 模式）。
import type { Serializer } from './serializer.js';
import { defaultSerializer } from './serializer.js';

/** 会话心跳配置：工厂返回本次心跳的 operation 与请求（未就绪返回 null 跳过本轮）。 */
export interface SessionHeartbeatConfig {
  intervalMs: number;
  factory: () => { op: string; req?: unknown } | null;
}

/** Option 应用后的通道配置全集（含默认值）。 */
export interface ChannelSettings {
  /** 传输心跳周期；≤0 关闭（连续 3 次失败判定死链）。 */
  heartbeatIntervalMs: number;
  /** 请求默认超时（可 per-call 覆盖）。 */
  invokeTimeoutMs: number;
  /** 单帧 body 上限（需与服务端对齐）。 */
  maxBodySize: number;
  /** 序列化插槽。 */
  serializer: Serializer;
  /** 断线自动重连开关。 */
  autoReconnect: boolean;
  /** 重连退避：base 起 ×2 封顶 max，带 ±20% 抖动。 */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 重连期间请求排队上限（满后立即失败）。 */
  reconnectQueueSize: number;
  /** 本通道重连成功后的会话钩子（重登/重绑）。 */
  onReconnected: (() => Promise<void> | void) | null;
  /** 钩子执行超时上限（hookBypass 直通窗口上限，超时视为失败弃用本代连接）。 */
  hookTimeoutMs: number;
  /** 会话心跳配置（仅业务通道生效；null = 不启用）。 */
  sessionHeartbeat: SessionHeartbeatConfig | null;
}

/** 通道级函数式配置项。 */
export type Option = (s: ChannelSettings) => void;

/** 默认配置（与 Go 侧默认对齐）。 */
export function defaultSettings(): ChannelSettings {
  return {
    heartbeatIntervalMs: 30_000,
    invokeTimeoutMs: 10_000,
    maxBodySize: 2 * 1024 * 1024,
    serializer: defaultSerializer,
    autoReconnect: true,
    backoffBaseMs: 500,
    backoffMaxMs: 30_000,
    reconnectQueueSize: 64,
    onReconnected: null,
    hookTimeoutMs: 10_000,
    sessionHeartbeat: null,
  };
}

/** 依序应用 Option。 */
export function applyOptions(opts: readonly Option[]): ChannelSettings {
  const s = defaultSettings();
  for (const o of opts) o(s);
  return s;
}

export function WithHeartbeatInterval(ms: number): Option {
  return (s) => {
    s.heartbeatIntervalMs = ms;
  };
}

export function WithInvokeTimeout(ms: number): Option {
  return (s) => {
    s.invokeTimeoutMs = ms;
  };
}

export function WithMaxBodySize(n: number): Option {
  return (s) => {
    s.maxBodySize = n;
  };
}

export function WithSerializer(serializer: Serializer): Option {
  return (s) => {
    s.serializer = serializer;
  };
}

export function WithAutoReconnect(enabled: boolean): Option {
  return (s) => {
    s.autoReconnect = enabled;
  };
}

export function WithBackoff(baseMs: number, maxMs: number): Option {
  return (s) => {
    s.backoffBaseMs = baseMs;
    s.backoffMaxMs = maxMs;
  };
}

export function WithReconnectQueueSize(n: number): Option {
  return (s) => {
    s.reconnectQueueSize = n;
  };
}

/** 注册本通道重连成功后的会话钩子：执行期间通道保持 Reconnecting（外部请求排队），
 * 钩子内 Invoke 经 hookBypass 直通当前代连接；超过 hookTimeout 视为失败——弃用本代
 * 连接、请求保留排队，退避重连后重试。dual 下经 newDualClient 自动链式编排。 */
export function WithOnReconnected(fn: () => Promise<void> | void): Option {
  return (s) => {
    s.onReconnected = fn;
  };
}

export function WithHookTimeout(ms: number): Option {
  return (s) => {
    s.hookTimeoutMs = ms;
  };
}

/** 配置会话心跳（仅业务通道生效）：周期调用业务 Heartbeat 续租会话；业务错误
 * 单飞触发重登钩子，网络错误静默（重连机制处理）。interval 需小于会话租期。 */
export function WithSessionHeartbeat(
  intervalMs: number,
  factory: () => { op: string; req?: unknown } | null,
): Option {
  return (s) => {
    s.sessionHeartbeat = { intervalMs, factory };
  };
}

/** per-call 覆盖项。 */
export interface InvokeOptions {
  failFast: boolean;
  timeoutMs?: number;
}

export type InvokeOption = (o: InvokeOptions) => void;

export function WithFailFast(): InvokeOption {
  return (o) => {
    o.failFast = true;
  };
}

/** per-call 超时覆盖（帧输入类高频请求设短超时，登录类慢请求设长超时）。 */
export function WithRequestTimeout(ms: number): InvokeOption {
  return (o) => {
    o.timeoutMs = ms;
  };
}
