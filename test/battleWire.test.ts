// wire 一致性测试：在本仓测试里起一个**最小 WS 服务端**（Node 原生 http + 手写 101
// 升级响应 + 手写 WS 帧读写），断言：
//   ① SDK 的升级请求行含 `?ticket=<base64url 票密文，无填充>`；
//   ② 升级后第一帧的会话槽字节与服务端期望**逐字节一致**（且与升级 query 同一取值）；
//   ③ 非 101（升级被拒）→ 明确失败且不重试。
// body 解析与 seq 提取均**手工**完成（不借 SDK 解析器），保证断言独立于被测实现。
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReplyOK, bytesOf, concatFrame } from './helpers.js';
import {
  BattleOps,
  MsgType,
  isEdgeRejected,
  openBattleSession,
  parseDirectPlan,
} from '../src/index.js';

/** 参考票密文与它的 base64url 取值（Node Buffer 独立给出，见 battlePlan.test.ts）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);
const SLOT = 'AQID-_8';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 一条解出的 WS 帧（客户端 → 服务端方向）。 */
interface WsFrame {
  opcode: number;
  payload: Buffer;
  rest: Buffer;
}

/** takeWsFrame 手工解析一条 WS 帧（客户端帧必带掩码；不足一帧返回 null）。 */
function takeWsFrame(buf: Buffer): WsFrame | null {
  if (buf.length < 2) return null;
  const opcode = (buf[0] ?? 0) & 0x0f;
  const masked = ((buf[1] ?? 0) & 0x80) !== 0;
  let len = (buf[1] ?? 0) & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return { opcode, payload, rest: buf.subarray(off + len) };
}

/** serverWsFrame 手工编码一条服务端帧（不掩码，二进制）。 */
function serverWsFrame(payload: Uint8Array, opcode = 0x2): Uint8Array {
  const len = payload.length;
  if (len >= 65536) throw new Error('测试帧过大');
  const head = len < 126 ? new Uint8Array(2) : new Uint8Array(4);
  head[0] = 0x80 | opcode;
  if (len < 126) {
    head[1] = len;
  } else {
    head[1] = 126;
    head[2] = len >> 8;
    head[3] = len & 0xff;
  }
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/** MiniWsServer：手写升级响应与帧读写的极简 WS 服务端（仅测试用）。 */
class MiniWsServer {
  private readonly server: Server;
  private socket: Duplex | null = null;
  private buf: Buffer = Buffer.alloc(0);
  /** 收到的客户端帧（整帧字节，未解 body）。 */
  readonly frames: Uint8Array[] = [];
  /** 升级请求的 URL（含 query）。 */
  upgradeUrl = '';
  /** 升级请求次数（断言「不重试」）。 */
  upgradeCount = 0;
  /** 监听端口（start 后可用）。 */
  port = 0;
  /** 回 403 而非 101（模拟接入层拒绝升级）。 */
  rejectUpgrade = false;
  /** 每收到一帧回调（测试侧按需回执）。 */
  onFrame: ((frame: Uint8Array) => void) | null = null;

  constructor() {
    this.server = createServer();
    this.server.on('upgrade', (req, socket) => this.onUpgrade(req, socket as Duplex));
  }

  /** start 监听随机端口并返回端口号。 */
  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') throw new Error('测试服务端未取到端口');
    this.port = addr.port;
    return this.port;
  }

  /** close 关闭连接与监听（幂等，测试收尾用）。 */
  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** send 向客户端写一条帧（服务端方向不掩码）。 */
  send(frame: Uint8Array): void {
    this.socket?.write(Buffer.from(frame));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex): void {
    this.upgradeCount += 1;
    this.upgradeUrl = req.url ?? '';
    if (this.rejectUpgrade) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => {});
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const f = takeWsFrame(this.buf);
      if (!f) return;
      this.buf = f.rest;
      if (f.opcode === 0x8) {
        this.socket?.end();
        return;
      }
      if (f.opcode !== 0x1 && f.opcode !== 0x2) continue;
      const frame = new Uint8Array(f.payload);
      this.frames.push(frame);
      this.onFrame?.(frame);
    }
  }
}

/** u32be 手工读大端 u32（帧头 seq / bodyLen 用）。 */
function u32be(b: Uint8Array, off: number): number {
  return (((b[off] ?? 0) << 24) | ((b[off + 1] ?? 0) << 16) | ((b[off + 2] ?? 0) << 8) | (b[off + 3] ?? 0)) >>> 0;
}

/** bodyOf 取帧 body（帧头固定 16 字节）。 */
function bodyOf(frame: Uint8Array): Uint8Array {
  return frame.subarray(16);
}

/** opOf 手工解 body 的 operation 段。 */
function opOf(body: Uint8Array): string {
  const n = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
  return new TextDecoder().decode(body.subarray(2, 2 + n));
}

/** slotOf 手工解 body 的会话槽段（紧随 operation 之后）。 */
function slotOf(body: Uint8Array): Uint8Array {
  const off = 2 + (((body[0] ?? 0) << 8) | (body[1] ?? 0));
  const n = ((body[off] ?? 0) << 8) | (body[off + 1] ?? 0);
  return body.subarray(off + 2, off + 2 + n);
}

/** 测试用服务端集合（afterEach 兜底关闭，避免句柄泄漏）。 */
const servers: MiniWsServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

/** startServer 起一个测试服务端并登记收尾。 */
async function startServer(): Promise<MiniWsServer> {
  const srv = new MiniWsServer();
  servers.push(srv);
  await srv.start();
  return srv;
}

describe('战斗直连 wire 一致性（真实 WS 升级）', () => {
  it('升级请求行含 ?ticket=<base64url>，首帧会话槽字节与期望逐字节一致', async () => {
    const srv = await startServer();
    const plan = parseDirectPlan({
      matchId: 'm-7',
      battleId: 'b-9',
      battleTicket: Buffer.from(TICKET).toString('base64'),
      endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: `127.0.0.1:${srv.port}` }],
    });
    // 服务端：对每条请求回成功回执（Atlas 帧再套 WS 帧；回执 seq 取自请求帧头）。
    srv.onFrame = (frame) => {
      const seq = u32be(frame, 8);
      const reply = concatFrame(MsgType.Response, seq, buildReplyOK(bytesOf('{"currentFrame":"3"}')));
      srv.send(serverWsFrame(reply));
    };
    const session = await openBattleSession(plan, { path: '/' });
    // ① 升级请求行走的是本局推送的 WS 面地址，票在 query（base64url，无填充）。
    expect(srv.upgradeUrl).toBe(`/?ticket=${SLOT}`);
    // ② 首帧 = JoinBattle，其会话槽字节 = base64url 取值的 ASCII（battle 侧按 base64url 解回票密文）。
    const first = srv.frames[0]!;
    const body = bodyOf(first);
    expect(opOf(body)).toBe(BattleOps.joinBattle);
    expect(Array.from(slotOf(body))).toEqual(Array.from(new TextEncoder().encode(SLOT)));
    expect(new TextDecoder().decode(slotOf(body))).toBe(SLOT);
    expect(new Uint8Array(Buffer.from(SLOT, 'base64url'))).toEqual(TICKET);
    // ③ 同一张票两处用：升级 query 的取值独立解回票密文（与帧会话槽同源）。
    const queryTicket = new URL(`ws://probe${srv.upgradeUrl}`).searchParams.get('ticket') ?? '';
    expect(queryTicket).toBe(SLOT);
    expect(new Uint8Array(Buffer.from(queryTicket, 'base64url'))).toEqual(TICKET);
    // ④ 直连链路可用：后续战斗 op 也带同一张票（槽字节不变）。
    await session.sendFrameInput({ input: { frameId: '1' } });
    expect(srv.frames.length).toBe(2);
    expect(Array.from(slotOf(bodyOf(srv.frames[1]!)))).toEqual(Array.from(new TextEncoder().encode(SLOT)));
    await session.close();
  });

  it('升级被拒（非 101）→ 明确失败且不重试（升级请求仅一次）', async () => {
    const srv = await startServer();
    srv.rejectUpgrade = true;
    const plan = parseDirectPlan({
      matchId: 'm-7',
      battleId: 'b-9',
      battleTicket: Buffer.from(TICKET).toString('base64'),
      endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: `127.0.0.1:${srv.port}` }],
    });
    const err = await openBattleSession(plan, { path: '/' }).catch((e: unknown) => e);
    expect(isEdgeRejected(err)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(srv.upgradeCount).toBe(1);
  });
});
