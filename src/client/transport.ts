// 传输层接口（v0.2 定义；真实通道 v0.3 实现）与内存 mock 传输（测试用）。
//
// 接口与 Go 侧 channelTransport 同构：
//   readFrame  单帧读取——内部负责字节流缓冲与切帧（TCP/KCP）或消息边界直读（WS）；
//              连接关闭/断连时 reject（调用方按错误分类处理）。
//   writeFrame 整帧原子写（并发场景由内核写锁保证不交错——接口实现只需单帧写语义）。
//   close      关闭连接；阻塞中的 readFrame 随即 reject。
import type { Header } from '../frame/constants.js';
import { encodeFrame, type FrameRead } from '../frame/frame.js';
import { NetworkError } from './errors.js';

/** 传输类型（与 Go 侧 Transport 常量同构）。 */
export const TransportKind = {
  TCP: 'tcp',
  WS: 'ws',
  KCP: 'kcp',
  UDP: 'udp',
  Memory: 'memory',
} as const;
export type TransportKind = (typeof TransportKind)[keyof typeof TransportKind];

/** 单次帧读取结果：一帧（header + body）。断连/关闭以 reject 表达。 */
export interface FrameResult {
  header: Header;
  body: Uint8Array;
}

/** 通道传输接口：每代连接一个实例（由拨号函数创建）。 */
export interface ChannelTransport {
  readonly kind: TransportKind;
  /** 读一帧；连接关闭后调用或读取中断连时 reject（NetworkError 语义）。 */
  readFrame(maxBodySize: number): Promise<FrameResult>;
  /** 写一帧（整帧原子语义；失败 reject）。 */
  writeFrame(header: Header, body: Uint8Array, maxBodySize?: number): Promise<void>;
  close(): Promise<void>;
}

/** 拨号配置（真实通道由 Dialer 实现消费；地址形态 host:port 或完整 URL）。 */
export interface DialConfig {
  readonly kind: TransportKind;
  readonly addr: string;
  readonly path?: string;
}

/** 拨号函数类型：建立一条传输连接。 */
export type TransportDialer = (cfg: DialConfig) => Promise<ChannelTransport>;

/** 服务端模拟器：对客户端写入帧的编程式应答（测试用）。 */
export interface MockServer {
  /** 注册客户端帧处理器（客户端每次 writeFrame 回调一次）。 */
  onFrame(handler: (header: Header, body: Uint8Array) => void): void;
  /** 投递一帧给客户端读循环（服务端主动发送：响应或推送）；
   * version 为响应帧头载荷编码（载荷编码协商 ver 分派测试用，缺省 1）。 */
  sendFrame(type: number, seq: number, body: Uint8Array, version?: number): void;
  /** 模拟服务端自动应答：收到 Request 帧后回同 seq 的 Response（statusHex 空 = 成功）。 */
  autoReply(payloadFor: (op: string, payload: Uint8Array) => Uint8Array): void;
  /** 模拟服务端主动推送 Notify 帧。 */
  notify(op: string, payload: Uint8Array): void;
  /** 模拟断连：阻塞中的 readFrame 以指定错误 reject（缺省 NetworkError）。 */
  drop(err?: Error): void;
}

/** 创建内存 mock 传输与服务端模拟器（每帧字节独立分配，无共享缓冲问题）。 */
export function createMockTransport(): { transport: ChannelTransport; server: MockServer; closed: Promise<void> } {
  const readQueue: FrameResult[] = [];
  const waiters: Array<{ resolve: (f: FrameResult) => void; reject: (e: Error) => void }> = [];
  let frameHandler: ((header: Header, body: Uint8Array) => void) | null = null;
  let readFail: Error | null = null;
  let isClosed = false;
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });

  function deliver(f: FrameResult): void {
    const w = waiters.shift();
    if (w) w.resolve(f);
    else readQueue.push(f);
  }

  function failAll(err: Error): void {
    for (const w of waiters.splice(0)) w.reject(err);
  }

  const server: MockServer = {
    onFrame(handler) {
      frameHandler = handler;
    },
    sendFrame(type, seq, body, version = 1) {
      if (isClosed) return;
      // 服务端帧按同一线格式编码（magic/version/type 合法，bodyLen=body.length；
      // version 对齐 Go fakeServer.replyVer：服务端配置的响应帧头载荷编码，缺省 1）
      const h: Header = { magic: 0x41544c53, version, type: type as Header['type'], seq, length: body.length };
      deliver({ header: h, body });
    },
    autoReply(payloadFor) {
      frameHandler = (header, body) => {
        if (header.type !== MsgTypeRequest) return;
        const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        const op = new TextDecoder().decode(body.subarray(2, 2 + opLen));
        const payload = body.subarray(2 + opLen);
        server.sendFrame(MsgTypeResponse, header.seq, payloadFor(op, payload));
      };
    },
    notify(op, payload) {
      server.sendFrame(MsgTypeNotify, nextNotifySeq(), buildBody(op, payload));
    },
    drop(err) {
      if (isClosed) return;
      isClosed = true;
      readFail = err ?? new NetworkError('连接已断开');
      failAll(readFail);
      notifyClosed();
    },
  };

  const transport: ChannelTransport = {
    kind: TransportKind.Memory,
    async readFrame() {
      if (readFail) throw readFail;
      const queued = readQueue.shift();
      if (queued) return queued;
      return new Promise<FrameResult>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    async writeFrame(header, body, maxBodySize) {
      if (isClosed) throw new NetworkError('连接已关闭');
      // 按线格式整帧校验编码（与真实通道对称：encodeFrame 负责长度校验）
      encodeFrame(header, body, maxBodySize ?? 0);
      frameHandler?.(header, body);
    },
    async close() {
      server.drop();
    },
  };

  return { transport, server, closed };
}

// ---- 内部辅助：服务端帧 body 构造（[opLen][op][payload]）与解析 ----

const MsgTypeRequest = 1;
const MsgTypeResponse = 2;
const MsgTypeNotify = 3;

let notifySeqCounter = 1000;
function nextNotifySeq(): number {
  return ++notifySeqCounter;
}

function buildBody(op: string, payload: Uint8Array): Uint8Array {
  const opBytes = new TextEncoder().encode(op);
  const out = new Uint8Array(2 + opBytes.length + payload.length);
  out[0] = opBytes.length >> 8;
  out[1] = opBytes.length & 0xff;
  out.set(opBytes, 2);
  out.set(payload, 2 + opBytes.length);
  return out;
}

export { buildBody as buildMockBody };
export type { FrameRead };
