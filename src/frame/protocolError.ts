/**
 * 帧协议非法错误：magic/version/type/seq/长度/wire 格式等校验失败的统一类型。
 *
 * 对拍 golden vectors 的「protocol」错误分类；上层（内核/通道层）据此判定
 * 协议级致命——不可重试，终止连接（与 Go frame.ErrProtocol 语义同构）。
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
