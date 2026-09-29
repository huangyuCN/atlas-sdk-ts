/**
 * Atlas 帧协议常量与帧头类型（唯一来源：框架仓 transport/frame 的三语言生成物，由
 * scripts/gen-dto.sh 快照到 src/frame/gen/{consts,codec}.ts——本文件只做转发，不写字面量；
 * 规范见 atlas 仓 docs/superpowers/specs/2026-08-28-client-sdk-multilang-design.md §2）。
 *
 * 本包为协议层，零运行时依赖（仅 Web 标准字节 API），浏览器与 Node 双目标共用。
 */
import {
  FLAG_REQUEST_I_D,
  FLAG_SESSION,
  MAX_OPERATION_LEN as GEN_MAX_OPERATION_LEN,
  MAX_REQUEST_I_D_LEN as GEN_MAX_REQUEST_ID_LEN,
  MAX_SESSION_LEN as GEN_MAX_SESSION_LEN,
  MSG_TYPE_NOTIFY,
  MSG_TYPE_REQUEST,
  MSG_TYPE_RESPONSE,
  VERSION2,
} from './gen/consts.js';

export {
  FLAG_SESSION,
  HEADER_SIZE,
  MAGIC,
  MAX_BODY_SIZE,
  MSG_TYPE_NOTIFY,
  MSG_TYPE_REQUEST,
  MSG_TYPE_RESPONSE,
  VERSION,
} from './gen/consts.js';

/** 载荷编码 ver=2（protobuf 二进制 wire format；生成物名为 VERSION2，本包沿用
 * 历史导出名 VERSION_2——SDK 内引用符号不变）。可选增强：服务端支持 ver=2 前
 * 勿在真实连接启用（protojson ver=1 永续支持）。 */
export const VERSION_2 = VERSION2;

/** 帧 flags 位图 bit1：请求帧 body 携带请求幂等键段（生成物名为 FLAG_REQUEST_I_D，
 * 本包沿用历史导出名 FLAG_REQUEST_ID——SDK 内引用符号不变）。 */
export const FLAG_REQUEST_ID = FLAG_REQUEST_I_D;

/** operation 名独立上限（防垃圾字符串耗内存；唯一来源是生成物，本处只做转发）。 */
export const MAX_OPERATION_LEN = GEN_MAX_OPERATION_LEN;

/** 会话槽（会话凭据）最大长度（字节；唯一来源是生成物，本处只做转发）。 */
export const MAX_SESSION_LEN = GEN_MAX_SESSION_LEN;

/** 帧 flags 保留位掩码：已定义位（bit0 会话槽 / bit1 幂等键）之外皆非法。
 * 由生成物位定义推导（不写字面量），掩码随协议演进自动收缩。 */
export const FLAG_RESERVED_MASK = ~(FLAG_SESSION | FLAG_REQUEST_ID) & 0xff;

/** 请求幂等键最大长度（字节；生成物名为 MAX_REQUEST_I_D_LEN，本包沿用历史
 * 导出名 MAX_REQUEST_ID_LEN——SDK 内引用符号不变）。 */
export const MAX_REQUEST_ID_LEN = GEN_MAX_REQUEST_ID_LEN;

/** 帧类型：请求（1）/ 响应（2）/ 服务端推送（3，不参与请求匹配）。 */
export const MsgType = {
  Request: MSG_TYPE_REQUEST,
  Response: MSG_TYPE_RESPONSE,
  Notify: MSG_TYPE_NOTIFY,
} as const;

export type MsgType = (typeof MsgType)[keyof typeof MsgType];

/** 帧头的客户端侧表示（唯一来源：生成物 codec.ts 的线格式类型，本处只做转发）。 */
export type { Header } from './gen/codec.js';

/** 序列化器的可选扩展接口（载荷编码版本声明，规范 §3.1 载荷编码协商）：
 * client.Serializer 的实现者（如将来的 @bufbuild/protobuf 序列化器）可选择
 * 性实现，未实现者默认 ver=1（protojson）。放在协议层以避免 contrib → client
 * 的依赖环（载荷编码版本本就是帧协议层概念；与 Go frame.Versioned 同构）。 */
export interface Versioned {
  readonly version: number;
}
