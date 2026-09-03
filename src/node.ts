// Node 平台子入口（import '@huangyucn/atlas-sdk-ts/node'）：
// 主入口（'.'）零平台依赖超集 + 含 node:net / node:dgram 依赖的 TCP / UDP 通道。
// 主入口零平台依赖（浏览器与嵌入式宿主安全；WS 通道在主入口，Node 亦可用）。
// Node 子入口 = 主入口全部导出 + TCP/UDP（评审 Fix：此前非主入口超集，
// 缺帧 API/WS/ChannelView/WithSerializer 等，切子入口用户会缺类型）。
import { newClient, type Client } from './client/client.js';
import type { Option } from './client/options.js';
import { dialTCP, tcpDialer } from './transport/tcp.js';
import { dialUDP, udpDialer, UDP_MAX_DATAGRAM } from './transport/udp.js';

export * from './index.js';
export { dialTCP, tcpDialer, dialUDP, udpDialer, UDP_MAX_DATAGRAM };
export type { Option, InvokeOption } from './client/options.js';

/** 创建 TCP 客户端（业务通道；等首连成功，失败 reject）。 */
export function newTCPClient(addr: string, opts: readonly Option[] = []): Promise<Client> {
  return newClient(tcpDialer(), { kind: 'tcp', addr }, 'business', opts);
}

/** 创建 UDP 客户端（业务通道语义；等 connect 完成后返回）。 */
export function newUDPClient(addr: string, opts: readonly Option[] = []): Promise<Client> {
  return newClient(udpDialer(), { kind: 'udp', addr }, 'business', opts);
}
