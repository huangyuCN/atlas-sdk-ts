// 大端 u32 字节序辅助（帧头、reply 包络共用；评审 Fix：此前 header/reply 各写
// 一份，且 header.getU32BE 曾缺 >>> 0 导致高位 uint32 解析为负数）。>>> 0 保证
// 无符号——bodyLen=0xffffffff、seq>=0x80000000 等高位为 1 的值不得变负。
/** 大端 u32 写入（offset 起 4 字节）。 */
export function putU32BE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset] = v >>> 24;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

/** 大端 u32 读取（offset 起 4 字节；无符号，高位为 1 不变负）。 */
export function getU32BE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  return (((b0 ?? 0) << 24) | ((b1 ?? 0) << 16) | ((b2 ?? 0) << 8) | (b3 ?? 0)) >>> 0;
}
