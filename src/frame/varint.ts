// protobuf varint（LEB128）读取——与 Go encoding/binary.Uvarint 同构：
// 最长 10 字节；第 10 字节（i=9）值 > 1 视为 64 位溢出非法；数据不足返回 0。
// 返回 [值(bigint), 消耗字节数]；bytes ≤ 0 表示非法（0=数据不足，-1=溢出非法）。
export type UvarintResult = { value: bigint; consumed: number } | { invalid: number };

export function readUvarint(b: Uint8Array, offset: number): UvarintResult {
  let x = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    const byte = b[offset + i];
    if (byte === undefined) {
      return { invalid: 0 }; // 数据不足
    }
    if (byte < 0x80) {
      if (i === 9 && byte > 1) {
        return { invalid: -1 }; // 64 位溢出
      }
      return { value: x | (BigInt(byte) << shift), consumed: i + 1 };
    }
    x |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  }
  return { invalid: -1 }; // 超过 10 字节
}
