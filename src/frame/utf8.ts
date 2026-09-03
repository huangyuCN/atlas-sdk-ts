// 手写 UTF-8 编解码——引擎宿主兼容加固（2026-09-01 立项决策）：
// TextEncoder/TextDecoder 是 Web/Node 宿主 API，不是 JS 语言标准；Cocos Creator 等
// 嵌入式 JS 引擎（原生 JSB 环境）与微信小游戏等宿主不保证提供全局。协议层自带实现：
//   encodeUtf8 与宿主 TextEncoder 行为对齐（lone surrogate 替换为 U+FFFD）；
//   decodeUtf8 与宿主 TextDecoder('utf-8', {fatal: true}) 行为对齐——严格校验，
//   无效序列抛 ProtocolError（协议字段内容损坏按协议错误处理，不静默替换），开头 BOM 剥离。
// 校验规则按 WHATWG UTF-8 解码标准：拒绝过度编码（C0/C1 头、E0 非 A0-BF、F0 非 90-BF）、
// 代理区三字节形态（ED A0-BF）、超 U+10FFFF（F4 90+）、孤立 continuation、截断序列。
import { ProtocolError } from './protocolError.js';

const REPLACEMENT = 0xfffd;

/** 将字符串编码为 UTF-8 字节。 */
export function encodeUtf8(str: string): Uint8Array {
  let byteLen = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++; // 合法代理对占两个 code unit
    byteLen += codePointSize(cp);
  }
  const out = new Uint8Array(byteLen);
  let off = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = REPLACEMENT; // 孤立代理项（非法）
    off = writeCodePoint(out, off, cp);
  }
  return out;
}

/** code point 的 UTF-8 字节长度。 */
function codePointSize(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/** 将 code point 写入 out 的 off 处，返回下一写入位置。 */
function writeCodePoint(out: Uint8Array, off: number, cp: number): number {
  if (cp < 0x80) {
    out[off++] = cp;
  } else if (cp < 0x800) {
    out[off++] = 0xc0 | (cp >> 6);
    out[off++] = 0x80 | (cp & 0x3f);
  } else if (cp < 0x10000) {
    out[off++] = 0xe0 | (cp >> 12);
    out[off++] = 0x80 | ((cp >> 6) & 0x3f);
    out[off++] = 0x80 | (cp & 0x3f);
  } else {
    out[off++] = 0xf0 | (cp >> 18);
    out[off++] = 0x80 | ((cp >> 12) & 0x3f);
    out[off++] = 0x80 | ((cp >> 6) & 0x3f);
    out[off++] = 0x80 | (cp & 0x3f);
  }
  return off;
}

/** 严格解码 UTF-8 字节为字符串（无效序列抛 ProtocolError）。 */
export function decodeUtf8(b: Uint8Array): string {
  let start = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) start = 3; // BOM 剥离
  // ASCII 快路径：全 < 0x80 时免逐字节状态机（operation 名的绝大多数形态）。
  let allAscii = true;
  for (let i = start; i < b.length; i++) {
    if ((b[i] ?? 0) >= 0x80) {
      allAscii = false;
      break;
    }
  }
  return allAscii ? fromAscii(b, start) : decodeStrict(b, start);
}

/** ASCII 快路径：分块 fromCharCode（避开 apply 参数上限）。 */
function fromAscii(b: Uint8Array, start: number): string {
  let s = '';
  for (let i = start; i < b.length; i += 4096) {
    const chunk: number[] = [];
    for (let j = i; j < i + 4096 && j < b.length; j++) chunk.push(b[j] ?? 0);
    s += String.fromCharCode(...chunk);
  }
  return s;
}

/** 严格解码状态机（非 ASCII 路径）。 */
function decodeStrict(b: Uint8Array, start: number): string {
  let s = '';
  let i = start;
  while (i < b.length) {
    const c = b[i] ?? 0;
    let cp: number;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if (c >= 0xc2 && c <= 0xdf) {
      cp = continuation(b, i, 1, 2, 0x80);
      i += 2;
    } else if (c >= 0xe0 && c <= 0xef) {
      cp = continuation(b, i, 2, 3, c === 0xe0 ? 0xa0 : 0x80);
      // E0 后续须 ≥A0（防过度编码，下界钳制）；ED 后续须 ≤9F（防代理区，上界钳制）
      if (c === 0xed && (b[i + 1] ?? 0) > 0x9f) throw new ProtocolError('frame: utf-8 解码失败');
      i += 3;
    } else if (c >= 0xf0 && c <= 0xf4) {
      cp = continuation(b, i, 3, 4, c === 0xf0 ? 0x90 : 0x80);
      if (c === 0xf4 && (b[i + 1] ?? 0) > 0x8f) throw new ProtocolError('frame: utf-8 解码失败');
      i += 4;
    } else {
      throw new ProtocolError('frame: utf-8 解码失败'); // 孤立 continuation / C0-C1 / F5-FF
    }
    // fromCharCode 只接受 code unit：>0xFFFF 的 code point 拆为代理对两个 code unit。
    if (cp > 0xffff) {
      s += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
    } else {
      s += String.fromCharCode(cp);
    }
  }
  return s;
}

/** 读取 n 字节 continuation 序列合成 code point；任一 continuation 非法即抛错。
 * 头字节合法性已由外层分支保证（此处只取其低位载荷）；firstMin 为首 continuation
 * 字节的下界（防过度编码）。 */
function continuation(b: Uint8Array, off: number, n: number, size: number, firstMin: number): number {
  let cp = (b[off] ?? 0) & (size === 2 ? 0x1f : size === 3 ? 0x0f : 0x07);
  for (let k = 1; k <= n; k++) {
    const byte = b[off + k];
    if (byte === undefined || byte < 0x80 || byte >= 0xc0) {
      throw new ProtocolError('frame: utf-8 解码失败'); // 截断或非法 continuation
    }
    if (k === 1 && byte < firstMin) {
      throw new ProtocolError('frame: utf-8 解码失败');
    }
    cp = (cp << 6) | (byte & 0x3f);
  }
  return cp;
}
