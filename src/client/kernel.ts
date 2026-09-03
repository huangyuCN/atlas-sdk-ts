// Node 平台内核导出聚合（node.ts 与主入口共享；避免与 client/client.js 的
// 具名导出重复维护——集中一处）。
export {
  AtlasError,
  BusinessError,
  NetworkError,
  ProtocolError,
  TimeoutError,
  isBusinessError,
  isProtocolError,
} from './errors.js';
export { HeartbeatOperation, HEARTBEAT_FAILURES } from './channel.js';
