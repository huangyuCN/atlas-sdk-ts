// 下行增量（ver=3）解码的公共出口：wire 合并 + 会话级状态机。
export {
  FrameDeltaField,
  mergeDelta,
  parseDelta,
  readFrameId,
  wireFieldsOf,
  type DeltaFields,
} from './merge.js';
export {
  DownlinkError,
  parseFields,
  readVarint,
  type WireField,
} from './wire.js';
export { DownlinkDecoder, type DecodedFrame, type Requester } from './decoder.js';
export { encodeKeyframeRequest } from './request.js';
