// WebSocket 通道（消息边界：一条 WS 消息 = 一个完整帧，decodeFrame 直用）。
// WebSocketLike 是浏览器原生 WebSocket 与 Cocos JSB WebSocket 的最小公约接口
// （on* 事件属性 + send/close）——桥接两侧避免按宿主分叉通道实现。
// 本文件零平台依赖（仅 Web 标准），主入口导出；Node 亦可用（其具备全局 WebSocket）。
import { encodeFrame, decodeFrame } from '../frame/frame.js';
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';
import { HEADER_SIZE, type Header } from '../frame/constants.js';
import { NetworkError, ProtocolError } from '../client/errors.js';
import type { ChannelTransport, DialConfig, TransportDialer } from '../client/transport.js';
import { TransportKind } from '../client/transport.js';

/** WebSocket 最小公约接口（浏览器原生 / Cocos JSB 兼容）。 */
export interface WebSocketLike {
  binaryType: string;
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** WebSocket 工厂类型：由宿主创建并已发起连接的 WS 实例。 */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** 将已发起连接的 WS 实例包装为通道传输：等 open 后返回；一条消息 = 一帧。
 * 文本消息与帧非法均视为协议错误（消息边界失步，终止连接）。 */
export function connectWebSocketTransport(
  ws: WebSocketLike,
  openTimeoutMs = 10_000,
): Promise<ChannelTransport> {
  return new Promise<ChannelTransport>((resolve, reject) => {
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      cleanupWait();
      try {
        ws.close();
      } catch {
        // 忽略关闭异常
      }
      reject(new NetworkError(`ws 握手超时（${openTimeoutMs}ms）`));
    }, openTimeoutMs);
    const cleanupWait = () => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };
    ws.onopen = () => {
      cleanupWait();
      resolve(new WsTransport(ws));
    };
    ws.onerror = () => {
      cleanupWait();
      reject(new NetworkError('ws 连接失败'));
    };
    ws.onclose = () => {
      cleanupWait();
      reject(new NetworkError('ws 连接被关闭'));
    };
  });
}

/** 拨号 WebSocket 通道：默认用全局 WebSocket（浏览器 / Cocos JSB / Node 22+）；
 * 宿主无全局 WebSocket（或需注入自定义实现）时经 opts.wsFactory 提供。 */
export function dialWebSocket(
  cfg: DialConfig,
  opts?: { wsFactory?: WebSocketFactory; openTimeoutMs?: number },
): Promise<ChannelTransport> {
  const url = cfg.addr.startsWith('ws://') || cfg.addr.startsWith('wss://')
    ? cfg.addr
    : `ws://${cfg.addr}${cfg.path ?? '/ws'}`;
  const factory = opts?.wsFactory ?? ((u: string) => {
    const Ctor = (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket;
    return new Ctor(u);
  });
  return connectWebSocketTransport(factory(url), opts?.openTimeoutMs ?? 10_000);
}

/** 与 Go 侧 DialWS 对齐的便捷拨号器（供 newClient 使用）。 */
export function wsDialer(opts?: { wsFactory?: WebSocketFactory; openTimeoutMs?: number }): TransportDialer {
  return (cfg: DialConfig) => dialWebSocket(cfg, opts);
}

/** WS 通道传输（open 之后）。读侧消息入队、readFrame 时解码（maxBodySize 是
 * per-call 参数，解码必须在读取时执行）；写侧整帧单次 send。 */
class WsTransport implements ChannelTransport {
  readonly kind = TransportKind.WS;
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private readFail: Error | null = null;
  private closed = false;

  constructor(private readonly ws: WebSocketLike) {
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => this.fail(new NetworkError('ws 连接已关闭'));
    ws.onerror = () => this.fail(new NetworkError('ws 连接错误'));
  }

  async readFrame(maxBodySize: number): Promise<{ header: Header; body: Uint8Array }> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        // 消息边界解码：长度与 bodyLen 不一致即失步（协议级致命）。
        const { header, body } = decodeFrame(queued, maxBodySize);
        return { header, body };
      }
      if (this.readFail) throw this.readFail;
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }
  }

  async writeFrame(header: Header, body: Uint8Array, maxBodySize?: number): Promise<void> {
    if (this.closed || this.readFail) throw new NetworkError('ws 连接已关闭');
    const frame = encodeFrame(header, body, maxBodySize ?? 0);
    this.ws.send(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch (err) {
      void err;
    }
    this.fail(new NetworkError('ws 连接已关闭'));
  }

  private onMessage(ev: { data: unknown }): void {
    if (this.readFail || this.closed) return;
    if (typeof ev.data === 'string') {
      this.fail(new ProtocolError('ws: 收到文本帧（协议要求二进制帧）'));
      return;
    }
    const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : (ev.data as Uint8Array);
    if (bytes.length < HEADER_SIZE) {
      this.fail(new FrameProtocolError(`ws: 消息短于帧头（${bytes.length}B）`));
      return;
    }
    const w = this.waiters.shift();
    if (w) {
      this.queue.push(bytes);
      w.resolve();
    } else {
      this.queue.push(bytes);
    }
  }

  private fail(err: Error): void {
    if (this.readFail) return;
    this.readFail = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }
}
