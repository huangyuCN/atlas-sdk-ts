// Node TCP 通道（node:net）：流式字节流，累积缓冲 + readFrameFrom 切帧。
// 粘包/半包由帧头 bodyLen 切分（对齐 Go frame.Read 语义）；读侧在 readFrame 时
// 按调用方 maxBodySize 校验切帧（data 事件只累积字节与唤醒，长度上限语义不旁路）；
// 断连由 socket error/close 或内核传输心跳死链判定驱动。仅 Node 目标（node 子入口）。
import * as net from 'node:net';
import { encodeFrame, readFrameFrom, type FrameRead } from '../frame/frame.js';
import type { Header } from '../frame/constants.js';
import { NetworkError, ProtocolError } from '../client/errors.js';
import type { ChannelTransport, DialConfig, TransportDialer } from '../client/transport.js';
import { TransportKind } from '../client/transport.js';

/** 拨号 TCP 通道（addr 形态 host:port）。 */
export function dialTCP(cfg: DialConfig, connectTimeoutMs = 10_000): Promise<ChannelTransport> {
  const { host, port } = splitAddr(cfg.addr);
  return new Promise<ChannelTransport>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new NetworkError(`tcp 连接超时（${connectTimeoutMs}ms）`));
    }, connectTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(new TcpTransport(socket));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new NetworkError('tcp 连接失败', err));
    });
  });
}

/** TCP 拨号器（供 newClient 使用）。 */
export function tcpDialer(connectTimeoutMs = 10_000): TransportDialer {
  return (cfg: DialConfig) => dialTCP(cfg, connectTimeoutMs);
}

function splitAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(':');
  if (idx < 0) throw new NetworkError(`tcp 地址缺端口: ${addr}`);
  return { host: addr.slice(0, idx) || '127.0.0.1', port: Number(addr.slice(idx + 1)) };
}

class TcpTransport implements ChannelTransport {
  readonly kind = TransportKind.TCP;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  /** 原始字节累积缓冲 + 消费游标（避免每帧整段拷贝）。 */
  private buf = new Uint8Array(0);
  private bufOff = 0;
  private readFail: Error | null = null;
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.once('error', (err) => this.fail(new NetworkError('tcp 连接错误', err)));
    socket.once('close', () => this.fail(new NetworkError('tcp 连接已关闭')));
  }

  async readFrame(maxBodySize: number): Promise<{ header: Header; body: Uint8Array }> {
    for (;;) {
      const res: FrameRead = readFrameFrom(this.buf, maxBodySize, this.bufOff);
      if (res.ok) {
        this.bufOff += res.consumed;
        this.compact();
        return { header: res.header, body: res.body };
      }
      if (res.reason === 'protocol') {
        // 帧协议非法 = 协议级错误（内核据此终止连接、不重连），不得降级为网络错误。
        const err = new ProtocolError('tcp 帧协议非法', res.cause);
        this.fail(err);
        throw err;
      }
      if (this.readFail) throw this.readFail;
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }
  }

  async writeFrame(header: Header, body: Uint8Array, maxBodySize?: number): Promise<void> {
    if (this.closed) throw new NetworkError('tcp 连接已关闭');
    const frame = encodeFrame(header, body, maxBodySize ?? 0);
    const socket = this.socket;
    return new Promise<void>((resolve, reject) => {
      // write 回调确认提交进内核缓冲；后续错误由 'error' 事件与读侧统一处理。
      socket.write(frame, (err) => (err ? reject(new NetworkError('tcp 写失败', err)) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.fail(new NetworkError('tcp 连接已关闭'));
  }

  private onData(chunk: Buffer): void {
    if (this.readFail || this.closed) return;
    const pending = this.buf.length - this.bufOff;
    const merged = new Uint8Array(pending + chunk.length);
    merged.set(this.buf.subarray(this.bufOff));
    merged.set(chunk, pending);
    this.buf = merged;
    this.bufOff = 0;
    // 唤醒挂起的 readFrame：由其循环按 maxBodySize 继续切帧。
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  /** 消费游标到底时重置缓冲，避免无限增长。 */
  private compact(): void {
    if (this.bufOff >= this.buf.length) {
      this.buf = new Uint8Array(0);
      this.bufOff = 0;
    }
  }

  private fail(err: Error): void {
    if (this.readFail) return;
    this.readFail = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}
