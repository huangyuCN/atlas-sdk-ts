// Atlas 帧编解码入口（协议层对外形态）。
//
// 帧格式（与服务端 transport/frame 一致，规范 §2）：
//   ┌──────────┬──────┬──────┬──────────┬───────┬───────────┐
//   │ magic(4) │ ver  │ type │flags(1)  │rsv(1) │ seq(4)│ bodyLen(4)│  大端，头固定 16B
//   └──────────┴──────┴──────┴──────────┴───────┴───────────┘
//
// body 内部封装（与 Go frame 包对称）：
//   ┌────────────────────────────────────────────────────────┐
//   │ opLen(2) │ operation │ [sessionLen(2) │ session] │ payload │
//   └────────────────────────────────────────────────────────┘
//
// 会话槽（flags bit0 = FLAG_SESSION）：无连接传输（UDP/KCP）的请求帧携带会话
// 凭据供服务端验证身份；长连接（TCP/WS）按连接绑定、不置位、body 无会话字段。
//
// 编解码唯一实现是生成物（src/frame/gen/codec.ts，由框架仓 gen-frame 产出、
// scripts/gen-dto.sh 快照）：本文件只保留 SDK 的对外形态（消息边界 / 流式三态）
// 与错误类型收敛，不再有手写字节解析逻辑（单源防漂移）。
//
// 两种使用形态（与 Go frame 包对称）：
//   - encodeFrame/decodeFrame：消息边界传输体（WebSocket——一条消息 = 一个完整帧）；
//     消息长度与 bodyLen 不一致视为协议非法（失步，上层按协议错误终止连接）。
//   - readFrameFrom：流式缓冲读取（TCP/KCP——粘包由帧头 bodyLen 切分）。
//     返回三态结构（TS 惯用法，替代 Go 的值/错误二分）：
//       incomplete = 需要更多数据（对应 io.EOF/UnexpectedEOF，golden 对拍归 network）；
//       protocol   = 头校验失败（golden 对拍归 protocol，上层终止连接）。
import {
  FrameCodecError,
  decode as decodeGen,
  decodeMessage as decodeMessageGen,
  encode as encodeGen,
  type Header,
} from './gen/codec.js';
import { HEADER_SIZE } from './constants.js';
import { asProtocolError } from './header.js';
import type { ProtocolError } from './protocolError.js';

/** 将 header 与 body 编码为完整帧字节（消息边界形态；转发生成物 encode）。
 * body 超过上限抛 ProtocolError；magic/version 零值按协议默认值补齐。 */
export function encodeFrame(h: Header, body: Uint8Array, maxBodySize = 0): Uint8Array {
  try {
    return encodeGen(h, body, maxBodySize);
  } catch (err) {
    throw asProtocolError(err);
  }
}

/** 从一条完整消息解析帧（消息边界形态；转发生成物 decodeMessage）。
 * 消息长度与帧头 bodyLen 不一致（含短于帧头）即协议非法——消息边界下已失步。 */
export function decodeFrame(msg: Uint8Array, maxBodySize = 0): { header: Header; body: Uint8Array } {
  try {
    return decodeMessageGen(msg, maxBodySize);
  } catch (err) {
    throw asProtocolError(err);
  }
}

/** readFrameFrom 的结果三态（TS 惯用判别联合，替代 Go 值/错误二分）。 */
export type FrameRead =
  | { ok: true; header: Header; body: Uint8Array; consumed: number }
  | { ok: false; reason: 'incomplete' }
  | { ok: false; reason: 'protocol'; cause: ProtocolError };

/** 流式缓冲读取：从 buf 的 offset 起尝试读出一帧（Go frame.Read 的缓冲形态，语义同构）。
 * 生成物 decode 为 datagram 口径：先校验帧头（失败归 protocol），再判 body 是否到齐
 * （不足归 incomplete）；成功时 body 为 buf 的子数组（零拷贝引用——调用方如需跨读取
 * 保留必须自行拷贝），consumed = 16 + bodyLen。 */
export function readFrameFrom(buf: Uint8Array, maxBodySize = 0, offset = 0): FrameRead {
  if (buf.length - offset < HEADER_SIZE) {
    return { ok: false, reason: 'incomplete' };
  }
  try {
    const { header, body } = decodeGen(buf.subarray(offset), maxBodySize);
    return { ok: true, header, body, consumed: HEADER_SIZE + header.length };
  } catch (err) {
    if (err instanceof FrameCodecError && err.kind === 'incomplete') {
      return { ok: false, reason: 'incomplete' };
    }
    return { ok: false, reason: 'protocol', cause: asProtocolError(err) };
  }
}

export { HEADER_SIZE };
