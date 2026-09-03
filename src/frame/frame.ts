// Atlas 帧编解码。
//
// 帧格式（与服务端 transport/frame 一致，规范 §2）：
//   ┌──────────┬──────┬──────┬────────┬───────┬───────────┐
//   │ magic(4) │ ver  │ type │ rsv(2) │ seq(4)│ bodyLen(4)│  大端，头固定 16B
//   └──────────┴──────┴──────┴────────┴───────┴───────────┘
//
// 两种使用形态（与 Go frame 包对称）：
//   - encodeFrame/decodeFrame：消息边界传输体（WebSocket——一条消息 = 一个完整帧）；
//     消息长度与 bodyLen 不一致视为协议非法（失步，上层按协议错误终止连接）。
//   - readFrameFrom：流式缓冲读取（TCP/KCP——粘包由帧头 bodyLen 切分）。
//     返回三态结构（TS 惯用法，替代 Go 的值/错误二分）：
//       incomplete = 需要更多数据（对应 io.EOF/UnexpectedEOF，golden 对拍归 network）；
//       protocol   = 头校验失败（golden 对拍归 protocol，上层终止连接）。
import { type Header, HEADER_SIZE, MAX_BODY_SIZE } from './constants.js';
import { checkHeader, decodeHeaderAt, encodeHeaderInto } from './header.js';
import { ProtocolError } from './protocolError.js';

/** 将 header 与 body 编码为完整帧字节（消息边界形态；与 Go frame.Encode 对称）。
 * body 超过上限抛 ProtocolError；magic/version 零值按协议默认值补齐。 */
export function encodeFrame(h: Header, body: Uint8Array, maxBodySize = 0): Uint8Array {
  const max = maxBodySize > 0 ? maxBodySize : MAX_BODY_SIZE;
  if (body.length > max) {
    throw new ProtocolError(`frame: body too large: ${body.length} > ${max}`);
  }
  const out = new Uint8Array(HEADER_SIZE + body.length);
  const hdr: Header = {
    magic: h.magic === 0 ? 0x41544c53 : h.magic,
    version: h.version === 0 ? 1 : h.version,
    type: h.type,
    seq: h.seq,
    length: body.length,
  };
  encodeHeaderInto(out, hdr);
  out.set(body, HEADER_SIZE);
  return out;
}

/** 从一条完整消息解析帧（消息边界形态；与 Go frame.Decode 对称）。 */
export function decodeFrame(msg: Uint8Array, maxBodySize = 0): { header: Header; body: Uint8Array } {
  if (msg.length < HEADER_SIZE) {
    throw new ProtocolError(`frame: message shorter than header: ${msg.length} < ${HEADER_SIZE}`);
  }
  const header = decodeHeaderAt(msg);
  checkHeader(header, maxBodySize);
  if (msg.length - HEADER_SIZE !== header.length) {
    throw new ProtocolError(
      `frame: message length mismatch bodyLen: ${msg.length - HEADER_SIZE} != ${header.length}`,
    );
  }
  return { header, body: msg.subarray(HEADER_SIZE) };
}

/** readFrameFrom 的结果三态（TS 惯用判别联合，替代 Go 值/错误二分）。 */
export type FrameRead =
  | { ok: true; header: Header; body: Uint8Array; consumed: number }
  | { ok: false; reason: 'incomplete' }
  | { ok: false; reason: 'protocol'; cause: ProtocolError };

/** 流式缓冲读取：从 buf 的 offset 起尝试读出一帧（Go frame.Read 的缓冲形态，语义同构）。
 * 长度校验先于任何 body 分配（防恶意大包撑内存）；成功时 body 为 buf 的子数组
 * （零拷贝引用——调用方如需跨读取保留必须自行拷贝），consumed = 16 + bodyLen。 */
export function readFrameFrom(buf: Uint8Array, maxBodySize = 0, offset = 0): FrameRead {
  if (buf.length - offset < HEADER_SIZE) {
    return { ok: false, reason: 'incomplete' };
  }
  const header = decodeHeaderAt(buf.subarray(offset));
  try {
    checkHeader(header, maxBodySize);
  } catch (err) {
    if (err instanceof ProtocolError) return { ok: false, reason: 'protocol', cause: err };
    throw err;
  }
  const end = offset + HEADER_SIZE + header.length;
  if (buf.length < end) {
    return { ok: false, reason: 'incomplete' }; // body 不足：对应 io.ErrUnexpectedEOF
  }
  return {
    ok: true,
    header,
    body: buf.subarray(offset + HEADER_SIZE, end),
    consumed: header.length + HEADER_SIZE,
  };
}

export { HEADER_SIZE };
