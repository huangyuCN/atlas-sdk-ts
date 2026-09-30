// Atlas SDK TypeScript —— 公共导出口。
// 协议层（v0.1）：帧编解码 / 包络 / Status / body / UTF-8。
// 运行时内核（v0.2）：Client 编排器、错误四分类、配置项、内存 mock 传输（测试桩）。
export * from './frame/index.js';
export {
  Client,
  ChannelView,
  Kind,
  newClient,
  newDualClient,
  type ChannelConfig,
  type ClientState,
} from './client/client.js';
export {
  AtlasError,
  BusinessError,
  NetworkError,
  ProtocolError,
  TimeoutError,
  isBusinessError,
  isProtocolError,
} from './client/errors.js';
export { JsonSerializer, defaultSerializer, type Serializer } from './client/serializer.js';
export {
  WithAutoReconnect,
  WithBackoff,
  WithFailFast,
  WithHeartbeatInterval,
  WithHookTimeout,
  WithInvokeTimeout,
  WithMaxBodySize,
  WithOnReconnected,
  WithRequestTimeout,
  WithReconnectQueueSize,
  WithSerializer,
  WithSessionHeartbeat,
  WithSessionTokenProvider,
  type InvokeOption,
  type Option,
} from './client/options.js';
export {
  asInvoker,
  type Invoker,
} from './client/invoker.js';
export {
  newSession,
  Session,
  SessionReplyUnresolvedError,
  WithAutoResume,
  WithResumeHook,
  WithSessionHeartbeatInterval,
  type SessionOption,
  type SessionSettings,
} from './client/session.js';
export {
  withSessionProtocol,
  type KickedResult,
  type PushEnvelope,
  type SessionOps,
  type SessionProtocol,
} from './client/sessionProtocol.js';
export { CLIENT_VERSION } from './version.js';
export {
  EdgeTransport,
  MATCH_STARTED_NOTIFY_OPS,
  isMatchStartedNotifyOp,
  parseDirectPlan,
  type DirectPlan,
} from './battle/plan.js';
export { BattleOps, BattlePushOps, DEFAULT_BATTLE_OPS, type BattleOpSet } from './battle/ops.js';
export { ticketSlotValue } from './battle/ticket.js';
export {
  BATTLE_TICKET_EXPIRED_REASON,
  BATTLE_TICKET_INVALID_REASON,
  isBattleTicketExpired,
  isBattleTicketRejected,
  isEdgeRejected,
} from './battle/errors.js';
export {
  openBattleSession,
  type BattleSession,
  type BattleSessionOptions,
  type BattleSessionState,
} from './battle/session.js';
export {
  TransportKind,
  createMockTransport,
  type ChannelTransport,
  type DialConfig,
  type MockServer,
  type TransportDialer,
} from './client/transport.js';
export { HeartbeatOperation, HEARTBEAT_FAILURES } from './client/channelTypes.js';
export type { NotifyHandler } from './client/notify.js';
export type { WebSocketLike, WebSocketFactory } from './transport/ws.js';
export { buildWsUrl, connectWebSocketTransport, dialWebSocket, wsDialer } from './transport/ws.js';
export { newWSClient } from './client/wsclient.js';
