// Channel 的纯函数辅助（从 channel.ts 拆出，控制单文件规模）：请求幂等键生成与
// 调试日志用的载荷摘要。二者都与连接状态无关（无副作用、不触碰 in-flight/队列），
// 故独立成模块便于单测与复用。

/** newRequestId 生成请求幂等键（crypto.getRandomValues 12 字节 base64url；零外部依赖）。 */
export function newRequestId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return base64UrlEncode(b);
}

/** base64UrlEncode 无 padding 的 URL-safe base64 编码。 */
function base64UrlEncode(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** payloadSnippet 取 payload 调试摘要（Debug 日志用：完整 JSON 截断 512 字节，防日志爆炸）。 */
export function payloadSnippet(data: Uint8Array): string {
  if (data.length === 0) return '{}';
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  return text.length > 512 ? text.slice(0, 512) + '...(truncated)' : text;
}
