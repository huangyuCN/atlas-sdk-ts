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
  /** 会话凭据提供者（Session 对象装配；业务层亦可自给）：无连接传输
   * （UDP/KCP）的请求帧据此自动携带会话槽（frame.FLAG_SESSION）。 */
  sessionToken: (() => string) | null;
  /** 调试日志实现（WithLog* Option；undefined + logOff=false = 默认 error 级 stderr）。 */
  logger?: SDKLogger;
  /** WithLogSilence：完全静默（显式关闭默认 error 输出）。 */
  logOff?: boolean;
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
    sessionToken: null,
  };
}

/** 依序应用 Option。 */
export function applyOptions(opts: readonly Option[]): ChannelSettings {
  const s = defaultSettings();
  for (const o of opts) o(s);
  // 未显式设置日志且未静默：默认 error 级 stderr（异常可见；收发打点是 debug 级，静默）。
  if (s.logger === undefined && !s.logOff) {
    s.logger = newStderrLogger('error');
  }
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

/** 注入会话凭据提供者（对齐 Go WithSessionTokenProvider；由 Session 对象装配，
 * 业务层亦可自给）：无连接传输（UDP/KCP）的请求帧据此自动携带会话槽
 * （frame.FLAG_SESSION），服务端按凭据验证身份；长连接（TCP/WS）按连接绑定，
 * 不携带。返回空串表示当前无会话（匿名帧，如登录前的 Login 请求）。 */
export function WithSessionTokenProvider(fn: () => string): Option {
  return (s) => {
    s.sessionToken = fn;
  };
}

/** per-call 覆盖项。 */
export interface InvokeOptions {
  failFast: boolean;
  /** 幂等键：显式指定（跨重试语义由调用方保证，如以订单号为键）；undefined = 自动生成。 */
  idempotencyKey?: string;
  /** 显式逃生门：本次不携带幂等键（服务端即使注解声明了幂等也收到空 ID 诚实不去重）。 */
  noIdempotency?: boolean;
  timeoutMs?: number;
}

export type InvokeOption = (o: InvokeOptions) => void;

export function WithFailFast(): InvokeOption {
  return (o) => {
    o.failFast = true;
  };
}

/** WithIdempotencyKey 显式指定本次调用的幂等键（覆盖自动生成）：同一键的重发/重试
 * 在服务端去重窗口内不重复产生副作用——适合按业务实体幂等（如以订单号为键）。
 * 服务端是否启用去重由接口的 atlas.route.v1 idempotency 注解决定。 */
export function WithIdempotencyKey(id: string): InvokeOption {
  return (o) => {
    o.idempotencyKey = id;
  };
}

/** WithNoIdempotency 使本次调用不携带幂等键（逃生门）：高频无副作用调用
 * （纯轮询/心跳）可省去 ID 生成与帧携带。 */
export function WithNoIdempotency(): InvokeOption {
  return (o) => {
    o.noIdempotency = true;
  };
}

/** per-call 超时覆盖（帧输入类高频请求设短超时，登录类慢请求设长超时）。 */
export function WithRequestTimeout(ms: number): InvokeOption {
  return (o) => {
    o.timeoutMs = ms;
  };
}

/** SDK 调试日志等级（数值越大越细；WithLog* Option 与之对应，默认 error）。 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silence';

/** SDKLogger 是调试日志输出接口（内置 stderr 实现或调用方自带实现）。 */
export interface SDKLogger {
  debugf(format: string, ...args: unknown[]): void;
  infof(format: string, ...args: unknown[]): void;
  warnf(format: string, ...args: unknown[]): void;
  errorf(format: string, ...args: unknown[]): void;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  silence: -1,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** 内置 stderr 日志器：按最小级别过滤（时间戳 + 级别前缀，零外部依赖）。 */
export function newStderrLogger(min: LogLevel): SDKLogger {
  const minOrder = LOG_LEVEL_ORDER[min];
  const fmt = (lv: Exclude<LogLevel, 'silence'>, msg: string): void => {
    if (LOG_LEVEL_ORDER[lv] < minOrder) return;
    console.error(`[atlas-sdk ${lv}] ${new Date().toISOString()} ${msg}`);
  };
  return {
    debugf: (m, ...a) => fmt('debug', interpolate(m, a)),
    infof: (m, ...a) => fmt('info', interpolate(m, a)),
    warnf: (m, ...a) => fmt('warn', interpolate(m, a)),
    errorf: (m, ...a) => fmt('error', interpolate(m, a)),
  };
}

/** WithLogSilence 完全关闭 SDK 调试日志。 */
export function WithLogSilence(): Option {
  return (s) => {
    s.logger = undefined;
    s.logOff = true;
  };
}

/** WithLogError 只打印 Error（与不设置等价的显式写法）。 */
export function WithLogError(): Option {
  return (s) => {
    s.logger = newStderrLogger('error');
  };
}

/** WithLogWarn 打印 Warn 及以上（含超时/重发）。 */
export function WithLogWarn(): Option {
  return (s) => {
    s.logger = newStderrLogger('warn');
  };
}

/** WithLogInfo 打印 Info 及以上（含连接事件）。 */
export function WithLogInfo(): Option {
  return (s) => {
    s.logger = newStderrLogger('info');
  };
}

/** WithLogDebug 打印 Debug 及以上（全开：每次收发的请求/响应 JSON、seq、幂等键）。 */
export function WithLogDebug(): Option {
  return (s) => {
    s.logger = newStderrLogger('debug');
  };
}

/** WithLogOutput 注入调用方自带的日志实现（等级由实现自身决定；panic 安全由调用方保证）。 */
export function WithLogOutput(l: SDKLogger): Option {
  return (s) => {
    s.logger = l;
  };
}

/** interpolate 依序替换 format 串中的 %s 占位（多余参数以空格续接）。 */
function interpolate(m: string, args: unknown[]): string {
  let i = 0;
  let out = m.replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s'));
  while (i < args.length) out += ' ' + String(args[i++]);
  return out;
}
