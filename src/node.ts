// Node 平台子入口（import '@huangyucn/atlas-sdk-ts/node'）：
// 主入口（'.'）的超集——额外含 node:net / node:dgram 依赖的 TCP / UDP 通道
// 与便捷构造（主入口零平台依赖：浏览器与嵌入式宿主只应引用主入口）。
import { newClient, newDualClient, type Client } from './client/client.js';
import type { Option } from './client/options.js';
import { dialTCP, tcpDialer } from './transport/tcp.js';
import { dialUDP, udpDialer, UDP_MAX_DATAGRAM } from './transport/udp.js';
import { wsDialer } from './transport/ws.js';
import type { TransportDialer } from './client/transport.js';

export * from './index.js';
export { dialTCP, tcpDialer, dialUDP, udpDialer, UDP_MAX_DATAGRAM, wsDialer };
export type { InvokeOption } from './client/options.js';

/** 按通道 kind 分派的 Node 拨号器（dual 异构传输场景：如 TCP 业务 + WS 战斗）。 */
export function nodeDialer(connectTimeoutMs = 10_000): TransportDialer {
  const tcp = tcpDialer(connectTimeoutMs);
  const udp = udpDialer(connectTimeoutMs);
  const ws = wsDialer({ openTimeoutMs: connectTimeoutMs });
  return (cfg) => {
    switch (cfg.kind) {
      case 'ws':
        return ws(cfg);
      case 'udp':
        return udp(cfg);
      default:
        return tcp(cfg);
    }
  };
}

/** 创建 TCP 客户端（业务通道；等首连成功，失败 reject）。 */
export function newTCPClient(addr: string, opts: readonly Option[] = []): Promise<Client> {
  return newClient(tcpDialer(), { kind: 'tcp', addr }, 'business', opts);
}

/** 创建 UDP 客户端（业务通道语义；等 connect 完成后返回）。 */
export function newUDPClient(addr: string, opts: readonly Option[] = []): Promise<Client> {
  return newClient(udpDialer(), { kind: 'udp', addr }, 'business', opts);
}

/** dual 客户端便捷构造（Node 拨号器按通道 kind 分派；battle 默认 WS）。
 * 网关按用途绑定通道（模板 D6）：业务通道走 TCP/WS 认证协议，
 * 战斗通道不做业务 Login（会话绑定业务通道），连通性用传输心跳验证。 */
export function newDualClientNode(
  business: { addr: string; opts?: Option[] },
  battle: { addr: string; kind?: 'ws' | 'tcp' | 'udp'; path?: string; opts?: Option[] },
  opts: readonly Option[] = [],
): Promise<Client> {
  return newDualClient(
    nodeDialer(),
    { transport: 'tcp', addr: business.addr, opts: business.opts },
    { transport: battle.kind ?? 'ws', addr: battle.addr, path: battle.path, opts: battle.opts },
    opts,
  );
}
