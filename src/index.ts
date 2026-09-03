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
  type InvokeOption,
  type Option,
} from './client/options.js';
export {
  TransportKind,
  createMockTransport,
  type ChannelTransport,
  type DialConfig,
  type MockServer,
  type TransportDialer,
} from './client/transport.js';
export { HeartbeatOperation, HEARTBEAT_FAILURES } from './client/channel.js';
export type { NotifyHandler } from './client/notify.js';
