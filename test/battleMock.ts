// 战斗直连会话测试用的 mock WebSocket 与「服务端」桩（不进 src，仅测试消费）：
//   MockWebSocket 实现 WebSocketLike（on* 事件由测试侧手控，与 ws.test.ts 同形）；
//   MockBattleServer 管理一条连接上的收帧记录与回执/推送/断连动作。
// 帧编解码全部走本仓协议层（readFrameFrom + parseRequestBodyFull），
// 因此测试断言的是**线上字节**而不仅是调用参数。
import { buildReplyErr, buildReplyOK, buildTestStatus, bytesOf, putU32BE } from './helpers.js';
import {
  MsgType,
  buildRequestBody,
  parseRequestBodyFull,
  readFrameFrom,
  type Header,
  type WebSocketFactory,
  type WebSocketLike,
} from '../src/index.js';

/** 一条被服务端侧解出的请求帧（flags 感知解析：段序 operation → 会话槽 → 幂等键 → 载荷）。 */
export interface DecodedRequest {
  header: Header;
  op: string;
  /** 帧会话槽（base64url 票密文；无槽为空串）。 */
  session: string;
  /** 请求幂等键（无为空串）。 */
  requestID: string;
  payload: Uint8Array;
}

/** MockWebSocket：最小 WebSocketLike 实现（sent 记录客户端发出的整帧字节）。 */
export class MockWebSocket implements WebSocketLike {
  binaryType = 'blob';
  readonly sent: Uint8Array[] = [];
  closedBySdk = false;
  /** 拨号被接入层拒：不 open，直接 error + close（模拟 L4 断开）。 */
  rejectBeforeOpen = false;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  /** 服务端完成升级（101）。 */
  serverOpen(): void {
    this.onopen?.();
  }

  /** 服务端投递一条帧（ArrayBuffer 形态，与浏览器一致）。 */
  serverFrame(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.slice().buffer });
  }

  /** 服务端主动断开连接。 */
  serverClose(): void {
    this.onclose?.();
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  }

  close(): void {
    if (this.closedBySdk) return;
    this.closedBySdk = true;
    this.onclose?.();
  }
}

/** MockBattleServer 是一条 mock 连接的服务端侧：收帧记录 + 回执/推送/断连原语。 */
export class MockBattleServer {
  readonly frames: DecodedRequest[] = [];
  private seqOfLast = 0;
  private pushSeq = 5000;
  private handler: ((req: DecodedRequest, srv: MockBattleServer) => void) | null = null;

  constructor(readonly ws: MockWebSocket) {
    const origSend = ws.send.bind(ws);
    ws.send = (data: ArrayBuffer | Uint8Array): void => {
      origSend(data);
      const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const req = decodeRequest(frame);
      if (!req) return;
      this.frames.push(req);
      this.seqOfLast = req.header.seq;
      this.handler?.(req, this);
    };
  }

  /** 每条请求回调一次（在工厂回调里配置，无需等待 open）。 */
  onRequest(handler: (req: DecodedRequest, srv: MockBattleServer) => void): void {
    this.handler = handler;
  }

  /** 回成功回执（payload 为空表示 Empty 消息）。 */
  replyOK(payload: Uint8Array = new Uint8Array(0), version = 1): void {
    this.ws.serverFrame(concatFrameV(MsgType.Response, this.seqOfLast, buildReplyOK(payload), version));
  }

  /** 回业务拒绝回执（Status 由 reason 构造）。 */
  replyStatus(reason: string, code = 401, version = 1): void {
    const body = buildReplyErr(buildTestStatus(code, reason, reason, null), new Uint8Array(0));
    this.ws.serverFrame(concatFrameV(MsgType.Response, this.seqOfLast, body, version));
  }

  /** 服务端推送（op 为消息完整名寻址；载荷为原始字节）。 */
  notify(op: string, payload: Uint8Array = new Uint8Array(0), version = 1): void {
    this.ws.serverFrame(concatFrameV(MsgType.Notify, ++this.pushSeq, buildRequestBody(op, payload), version));
  }

  /** 服务端断开（网络断连语义）。 */
  drop(): void {
    this.ws.serverClose();
  }

  /** 最近一条请求的 op（无请求为空串）。 */
  lastOp(): string {
    return this.frames[this.frames.length - 1]?.op ?? '';
  }

  /** 指定 op 收到的请求条数。 */
  countOp(op: string): number {
    return this.frames.filter((f) => f.op === op).length;
  }
}

/** concatFrameV 构造完整帧字节（帧头载荷编码版本可指定；与服务端线格式一致）。 */
function concatFrameV(type: number, seq: number, body: Uint8Array, version: number): Uint8Array {
  const out = new Uint8Array(16 + body.length);
  putU32BE(out.subarray(0, 4), 0x41544c53);
  out[4] = version;
  out[5] = type;
  putU32BE(out.subarray(8, 12), seq);
  putU32BE(out.subarray(12, 16), body.length);
  out.set(body, 16);
  return out;
}

/** decodeRequest flags 感知解帧；非请求帧返回 null。 */
function decodeRequest(frame: Uint8Array): DecodedRequest | null {
  const r = readFrameFrom(frame, 0);
  if (!r.ok || r.header.type !== MsgType.Request) return null;
  const parsed = parseRequestBodyFull(r.body, r.header.flags ?? 0);
  return {
    header: r.header,
    op: parsed.operation,
    session: parsed.session,
    requestID: parsed.requestID,
    payload: parsed.payload,
  };
}

/** BattleHarness 是一次测试里的拨号记录（urls 与 servers 按拨号序号对齐）。 */
export interface BattleHarness {
  factory: WebSocketFactory;
  sockets: MockWebSocket[];
  servers: MockBattleServer[];
  urls: string[];
}

/** makeBattleFactory 产出「每次拨号新建一条 mock 连接」的 WS 工厂；
 * configure 在拨号时（open 之前）同步回调，用于配置服务端应答行为。
 * 默认在微任务里完成升级；rejectBeforeOpen 置位时改为 error + close（模拟被拒）。 */
export function makeBattleFactory(
  configure?: (srv: MockBattleServer, index: number) => void,
): BattleHarness {
  const sockets: MockWebSocket[] = [];
  const servers: MockBattleServer[] = [];
  const urls: string[] = [];
  const factory: WebSocketFactory = (url) => {
    const ws = new MockWebSocket(url);
    const srv = new MockBattleServer(ws);
    sockets.push(ws);
    servers.push(srv);
    urls.push(url);
    configure?.(srv, servers.length - 1);
    queueMicrotask(() => {
      if (ws.rejectBeforeOpen) {
        ws.onerror?.();
        ws.onclose?.();
        return;
      }
      ws.serverOpen();
    });
    return ws;
  };
  return { factory, sockets, servers, urls };
}

/** jsonBytes 把对象编码为 protojson 风格的载荷字节（测试构造用）。 */
export function jsonBytes(obj: unknown): Uint8Array {
  return bytesOf(JSON.stringify(obj));
}
