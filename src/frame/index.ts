// 协议层公共导出（帧编解码 / 包络 / Status / body / 错误分类 / 载荷编码版本 /
// 帧 flags 位图与 body 会话槽）。
export {
  FLAG_SESSION,
  HEADER_SIZE,
  MAGIC,
  MAX_BODY_SIZE,
  MAX_OPERATION_LEN,
  MAX_SESSION_LEN,
  MsgType,
  VERSION,
  VERSION_2,
} from './constants.js';
export type { Header, Versioned } from './constants.js';
export { ProtocolError } from './protocolError.js';
export { checkHeader } from './header.js';
export {
  decodeFrame,
  encodeFrame,
  readFrameFrom,
  type FrameRead,
} from './frame.js';
export {
  buildRequestBody,
  buildRequestBodyWithSession,
  parseRequestBody,
  parseRequestBodyWithSession,
} from './body.js';
export { decodeStatus, type Status } from './status.js';
export { decodeReply, type DecodedReply } from './reply.js';
export { decodeUtf8, encodeUtf8 } from './utf8.js';
