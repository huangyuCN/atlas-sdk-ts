// 内核错误四分类（规范 §7）：BusinessError（服务端业务拒绝）/ NetworkError（连接与
// 发送故障）/ TimeoutError（请求超时）/ ProtocolError（帧与包络非法）。
// AtlasError 为抽象基类（name 固定 "AtlasError"）；cause 为手动赋值属性——不依赖
// ES2022 语言内置 Error.cause（引擎宿主如 Cocos 原生 JSB 环境对 ES2022 支持无保证）。
//
// 与协议层 src/frame/protocolError.ts 的关系：读循环边界把帧层哨兵包装为本类型
// （cause 链）；两者语义等价（都是协议错误），isProtocolError 同时识别两层——
// 用户直接调 decodeFrame 等协议层 API 抛的帧层错误同样被判定为协议错误。
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';

/** 内核错误抽象基类：四分类共享 name="AtlasError" 与手动赋值的 cause。 */
export abstract class AtlasError extends Error {
  /** 错误链路：手动赋值（不依赖 ES2022 语言内置 cause）。 */
  cause?: unknown;

  protected constructor(message: string) {
    super(message);
    this.name = 'AtlasError';
  }
}

/** 业务拒绝：失败响应包络携带的 Status 还原（业务分支主键是 Reason）。 */
export class BusinessError extends AtlasError {
  readonly code: number;
  readonly reason: string;
  readonly messageText: string;
  readonly metadata?: Record<string, string>;

  constructor(code: number, reason: string, message: string, metadata?: Record<string, string>) {
    super(`business error: code=${code} reason=${reason} message=${message}`);
    this.code = code;
    this.reason = reason;
    this.messageText = message;
    this.metadata = metadata;
  }
}

/** 网络故障：连接断开、发送失败、重连排队溢出。自动重连后可重试。 */
export class NetworkError extends AtlasError {
  constructor(message: string, cause?: unknown) {
    super(`network error: ${message}`);
    if (cause !== undefined) this.cause = cause;
  }
}

/** 请求超时：谨重重试（请求可能已到达服务端）。 */
export class TimeoutError extends AtlasError {
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(`timeout: ${operation} 超过 ${timeoutMs}ms 无响应`);
    this.operation = operation;
  }
}

/**
 * 协议错误：帧解码失败、包络非法、Status 解码失败。连接不可重试。
 *
 * 与协议层 src/frame/protocolError.ts 的哨兵关系：协议层错误在内核边界（读循环
 * catch）被包装为本类型，cause 指向原始 FrameProtocolError——两层分类哨兵各自
 * 独立成立（协议层 golden 对拍用 FrameProtocolError，内核错误分支用本类型），
 * 不用类型继承耦合依赖方向（frame 层不得依赖 client 层）。
 */
export class ProtocolError extends AtlasError {
  constructor(message: string, cause?: unknown) {
    super(`protocol error: ${message}`);
    if (cause !== undefined) this.cause = cause;
  }
}

/** 业务拒绝判定：按 Reason 精确匹配（不比对 Code 与 metadata）。 */
export function isBusinessError(err: unknown, reason?: string): err is BusinessError {
  if (!(err instanceof BusinessError)) return false;
  return reason === undefined || err.reason === reason;
}

/** 判定协议错误（评审缺陷修复：此前只认内核 ProtocolError；用户直接调协议层
 * decodeFrame/readFrameFrom 抛的帧层 ProtocolError 无法识别——语义等价应同判）。 */
export function isProtocolError(err: unknown): err is ProtocolError {
  return err instanceof ProtocolError || err instanceof FrameProtocolError;
}
