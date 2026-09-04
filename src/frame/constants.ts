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

/** 当前默认协议版本（载荷编码 ver=1：protojson JSON，规范 §3.1 载荷编码协商）。 */
export const VERSION = 1;

/** 载荷编码 ver=2（protobuf 二进制 wire format；规范 §3.1 载荷编码协商，
 * 2026-09-04 v0.5 设计决策）。可选增强：服务端支持 ver=2 前勿在真实连接启用
 * （protojson ver=1 永续支持）。 */
export const VERSION_2 = 2;

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

/** 序列化器的可选扩展接口（载荷编码版本声明，规范 §3.1 载荷编码协商）：
 * client.Serializer 的实现者（如将来的 @bufbuild/protobuf 序列化器）可选择
 * 性实现，未实现者默认 ver=1（protojson）。放在协议层以避免 contrib → client
 * 的依赖环（载荷编码版本本就是帧协议层概念；与 Go frame.Versioned 同构）。 */
export interface Versioned {
  readonly version: number;
}
