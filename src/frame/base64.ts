// 手写 base64 编解码（引擎宿主兼容加固，与 utf8.ts 同口径：不依赖 atob/btoa/Buffer）。
//   encodeBase64UrlRaw —— URL-safe 字母表的 base64（RawURLEncoding，**无填充**）：
//     战斗直连票据的唯一编码形态（接入层升级 query `?ticket=` 与帧会话槽共用同一取值，
//     两侧约定见规格 §3.2/§3.3）；
//   decodeBase64Std —— 标准字母表的 base64 解码（容忍缺失填充）：protojson 把 bytes
//     字段编成**标准 base64（带填充）**，成局通知里的 battle_ticket 需要还原为票密文。
// 非法字符/非法长度一律抛 ProtocolError：票是身份凭据，坏票必须显式报错而不是静默截断。
import { ProtocolError } from './protocolError.js';

const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** encodeBase64UrlRaw 把字节编码为 URL-safe base64（无填充）。 */
export function encodeBase64UrlRaw(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += URL_ALPHABET.charAt((n >> 18) & 63);
    out += URL_ALPHABET.charAt((n >> 12) & 63);
    if (b1 === undefined) break;
    out += URL_ALPHABET.charAt((n >> 6) & 63);
    if (b2 === undefined) break;
    out += URL_ALPHABET.charAt(n & 63);
  }
  return out;
}

/** decodeBase64Std 解码标准 base64（容忍缺失的尾部填充）；非法输入抛 ProtocolError。 */
export function decodeBase64Std(text: string): Uint8Array {
  const clean = text.replace(/[ \t\r\n]/g, '');
  const core = stripPadding(clean);
  if (core.length % 4 === 1) {
    throw new ProtocolError('base64: 长度非法（余 1 字符不可能构成合法编码）');
  }
  const out = new Uint8Array(Math.floor((core.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let off = 0;
  for (let i = 0; i < core.length; i++) {
    const v = STD_ALPHABET.indexOf(core.charAt(i));
    if (v < 0) {
      throw new ProtocolError(`base64: 非法字符 ${core.charAt(i)}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[off++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** stripPadding 去掉合法的尾部 '='（最多两个；'=' 出现在中间即非法）。 */
function stripPadding(clean: string): string {
  const body = clean.replace(/=+$/, '');
  if (body.includes('=')) {
    throw new ProtocolError('base64: 填充字符只能出现在末尾');
  }
  if (clean.length - body.length > 2) {
    throw new ProtocolError('base64: 填充字符过多');
  }
  return body;
}
