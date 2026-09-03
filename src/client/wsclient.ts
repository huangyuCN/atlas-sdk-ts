// WebSocket 客户端便捷构造（浏览器 / Cocos / Node 通用；主入口导出）。
import { newClient, type Client } from './client.js';
import type { Option } from './options.js';
import { wsDialer, type WebSocketFactory } from '../transport/ws.js';

/** 创建 WebSocket 客户端（single 形态；url 为完整 ws://host:port/path）。
 * Cocos 原生等无全局 WebSocket 的宿主经 wsFactory 注入自己的 WS 实现。 */
export function newWSClient(
  url: string,
  opts: readonly Option[] = [],
  wsFactory?: WebSocketFactory,
): Promise<Client> {
  return newClient(wsDialer({ wsFactory }), { kind: 'ws', addr: url }, 'business', opts);
}
