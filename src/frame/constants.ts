/**
 * Atlas 帧协议常量（与服务端 transport/frame 保持一致；规范见 atlas 仓
 * docs/superpowers/specs/2026-08-28-client-sdk-multilang-design.md §2）。
 *
 * 本包为协议层，零运行时依赖（仅 Web 标准字节 API），浏览器与 Node 双目标共用。
 */

/** 帧头固定长度（字节）。 */
export const HEADER_SIZE = 16;

/** 帧协议魔数（"ATLS"）。 */
export const MAGIC = 0x41544c53;

/** 当前协议版本。 */
export const VERSION = 1;

/** 单帧 body 绝对上限（2MiB，与服务端 frame.MaxBodySize 对齐；可配但两端必须对齐）。 */
export const MAX_BODY_SIZE = 2 * 1024 * 1024;

/** operation 名独立上限（服务端 dispatch 同款，防垃圾字符串耗内存）。 */
export const MAX_OPERATION_LEN = 4096;

/** 帧类型：请求（1）/ 响应（2）/ 服务端推送（3，不参与请求匹配）。 */
export const MsgType = {
  Request: 1,
  Response: 2,
  Notify: 3,
} as const;

export type MsgType = (typeof MsgType)[keyof typeof MsgType];

/** 帧头的客户端侧表示（与 Go frame.Header 同构；rsv 2 字节不表示）。 */
export interface Header {
  magic: number;
  version: number;
  type: MsgType;
  seq: number;
  length: number;
}
