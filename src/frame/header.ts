// 帧头校验入口：唯一实现是生成物（src/frame/gen/codec.ts，由框架仓 gen-frame 产出、
// scripts/gen-dto.sh 快照），本文件只把生成物的错误收敛为 SDK 的 ProtocolError
// ——对外导出名 checkHeader 保持不变，手写校验逻辑已删净（单源防漂移）。
import { FrameCodecError, checkHeader as checkHeaderGen, type Header } from './gen/codec.js';
import { ProtocolError } from './protocolError.js';

/** checkHeader 校验帧头合法性：magic / seq≠0 / type 白名单 / version 白名单 / flags 保留位 / 长度上限。
 * maxBodySize ≤ 0 时回退绝对上限（与 Go Header.Check 同构）；失败统一抛 ProtocolError。 */
export function checkHeader(h: Header, maxBodySize = 0): void {
  try {
    checkHeaderGen(h, maxBodySize);
  } catch (err) {
    throw asProtocolError(err);
  }
}

/** asProtocolError 把生成物抛出的错误收敛为 SDK 的 ProtocolError（已是该类型时原样返回）。 */
export function asProtocolError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  return new ProtocolError(err instanceof Error ? err.message : String(err));
}
