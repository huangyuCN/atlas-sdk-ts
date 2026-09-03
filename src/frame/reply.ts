// 响应包络解码（与 Go frame.DecodeReply 同构）：
//   成功 [hasError=0(1B)][dataLen:u32][data...]
//   失败 [hasError=1(1B)][statusLen:u32][Status protobuf][dataLen:u32][data...]
// statusLen=0 是合法包络（服务端 Status 序列化失败时的降级形态），容忍为零值 Status；
// dataLen 之外的尾随字节忽略（只按长度取范围，与 Go 一致）。
import { getU32BE } from './bytes.js';
import { ProtocolError } from './protocolError.js';
import type { Status } from './status.js';
import { decodeStatus } from './status.js';

/** 解码结果：data 恒为 Uint8Array（可能为空）；status 仅失败包络非 null。 */
export interface DecodedReply {
  data: Uint8Array;
  status: Status | null;
}

/** 解析响应包络；任何截断/长度非法抛 ProtocolError（包络非法 = 协议级致命）。 */
export function decodeReply(b: Uint8Array): DecodedReply {
  if (b.length < 5) {
    throw new ProtocolError(`frame: reply 过短`);
  }
  const hasError = b[0];
  if (hasError === 0) {
    const dataLen = getU32BE(b, 1);
    if (b.length < 5 + dataLen) {
      throw new ProtocolError(`frame: reply data 截断`);
    }
    return { data: b.subarray(5, 5 + dataLen), status: null };
  }

  const statusLen = getU32BE(b, 1);
  if (b.length < 5 + statusLen) {
    throw new ProtocolError(`frame: reply status 截断`);
  }
  const status: Status = statusLen > 0 ? decodeStatus(b.subarray(5, 5 + statusLen)) : { code: 0, reason: '', message: '' };
  const off = 5 + statusLen;
  if (b.length < off + 4) {
    throw new ProtocolError(`frame: reply data 截断`);
  }
  const dataLen = getU32BE(b, off);
  if (b.length < off + 4 + dataLen) {
    throw new ProtocolError(`frame: reply data 截断`);
  }
  return { data: b.subarray(off + 4, off + 4 + dataLen), status };
}
