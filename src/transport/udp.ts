// Node UDP 通道（node:dgram）：面向连接（connect 后 send/recv 固定对端，对齐
// Go DialUDP 语义）；一报一帧（一条 message = 一个完整帧）；单数据报上限 64KiB
// 含 16B 帧头（写侧提前拦截，对齐服务端读缓冲截断语义）；坏数据报静默丢弃
// （服务端 ErrBadFrame 软跳过语义，防垃圾/放大攻击）。仅 Node 目标（node 子入口）。
import * as dgram from 'node:dgram';
import { encodeFrame, decodeFrame } from '../frame/frame.js';
import { HEADER_SIZE, type Header } from '../frame/constants.js';
import { NetworkError, ProtocolError } from '../client/errors.js';
import type { ChannelTransport, DialConfig, TransportDialer } from '../client/transport.js';
import { TransportKind } from '../client/transport.js';

/** UDP 通道单数据报上限（字节，含 16B 帧头；服务端读缓冲默认 64KiB）。 */
export const UDP_MAX_DATAGRAM = 64 * 1024;

/** 拨号 UDP 通道（addr 形态 host:port；面向连接语义）。 */
export function dialUDP(cfg: DialConfig, connectTimeoutMs = 10_000): Promise<ChannelTransport> {
  const { host, port } = splitAddr(cfg.addr);
  return new Promise<ChannelTransport>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new NetworkError(`udp connect 超时（${connectTimeoutMs}ms）`));
    }, connectTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      // 移除拨号阶段 error 监听：后续错误由 UdpTransport 的持续监听处理
      // （评审 Blocker：残留 once 会先吞掉一次活跃期错误）。
      socket.removeAllListeners('error');
      resolve(new UdpTransport(socket));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new NetworkError('udp connect 失败', err));
    });
    socket.connect(port, host);
  });
}

/** UDP 拨号器（供 newClient 使用）。 */
export function udpDialer(connectTimeoutMs = 10_000): TransportDialer {
  return (cfg: DialConfig) => dialUDP(cfg, connectTimeoutMs);
}

function splitAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(':');
  if (idx < 0) throw new NetworkError(`udp 地址缺端口: ${addr}`);
  return { host: addr.slice(0, idx) || '127.0.0.1', port: Number(addr.slice(idx + 1)) };
}

class UdpTransport implements ChannelTransport {
  readonly kind = TransportKind.UDP;
  /** 原始数据报字节待取队列（解码在 readFrame 侧按 maxBodySize 执行——评审
   * Fix：此前事件侧固定以 0 解码绕过实例上限，WithMaxBodySize 对入站失效）。 */
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private readFail: Error | null = null;
  private closed = false;

  constructor(private readonly socket: dgram.Socket) {
    socket.on('message', (msg: Buffer) => this.onMessage(msg));
    // 持续监听（评审 Blocker：此前用 once，首次 error 后监听移除，活跃 socket
    // 再次 error 无监听 → Node 抛 unhandled 'error' 事件终止进程）。
    // ICMP 不可达等错误静默（无连接语义：死链由心跳发现，对齐 Go DialUDP）。
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return;
      this.fail(new NetworkError('udp 连接错误', err));
    });
    socket.once('close', () => this.fail(new NetworkError('udp 连接已关闭')));
  }

  async readFrame(maxBodySize: number): Promise<{ header: Header; body: Uint8Array }> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        // 按读取侧上限解码；坏数据报（垃圾/截断/非法头/超限）软跳过并继续读
        // （对齐 Go udpTransport 读缓冲截断软跳过语义，不视为连接故障）。
        try {
          return decodeFrame(queued, maxBodySize);
        } catch {
          continue;
        }
      }
      if (this.readFail) throw this.readFail;
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }
  }

  async writeFrame(header: Header, body: Uint8Array, maxBodySize?: number): Promise<void> {
    if (this.closed || this.readFail) throw new NetworkError('udp 连接已关闭');
    // 写侧提前拦截：超限数据报在服务端读缓冲处被截断后丢弃，提前报错让调用方
    // 立刻感知配置问题而非静默失败（对齐 Go udpTransport.WriteFrame）。
    if (body.length + HEADER_SIZE > UDP_MAX_DATAGRAM) {
      throw new ProtocolError(`udp: 数据报过大: ${body.length} body + ${HEADER_SIZE} 头 > ${UDP_MAX_DATAGRAM}`);
    }
    const frame = encodeFrame(header, body, maxBodySize ?? 0);
    const socket = this.socket;
    return new Promise<void>((resolve, reject) => {
      socket.send(frame, (err) => (err ? reject(new NetworkError('udp 发送失败', err)) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // 已关闭
    }
    this.fail(new NetworkError('udp 连接已关闭'));
  }

  private onMessage(msg: Buffer): void {
    if (this.readFail || this.closed) return;
    // 消息短于帧头即坏报：事件侧丢弃（避免垃圾入队）——长度上限校验留待
    // readFrame 按调用方 maxBodySize 执行。
    if (msg.length < HEADER_SIZE) return;
    const w = this.waiters.shift();
    this.queue.push(new Uint8Array(msg));
    w?.resolve();
  }

  private fail(err: Error): void {
    if (this.readFail) return;
    this.readFail = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}
