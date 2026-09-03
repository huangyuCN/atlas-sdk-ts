// 协议层公共导出（帧编解码 / 包络 / Status / body / 错误分类）。
export {
  HEADER_SIZE,
  MAGIC,
  MAX_BODY_SIZE,
  MAX_OPERATION_LEN,
  MsgType,
  VERSION,
} from './constants.js';
export type { Header } from './constants.js';
export { ProtocolError } from './protocolError.js';
export {
  decodeFrame,
  encodeFrame,
  readFrameFrom,
  type FrameRead,
} from './frame.js';
export { buildRequestBody, parseRequestBody } from './body.js';
export { decodeStatus, type Status } from './status.js';
export { decodeReply, type DecodedReply } from './reply.js';
export { decodeUtf8, encodeUtf8 } from './utf8.js';
