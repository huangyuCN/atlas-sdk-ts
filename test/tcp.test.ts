// Node TCP 通道回环测试（真实 socket，本地回环无外部依赖）：
// 往返、粘包（一次写两帧）、半包（分两次写）、断连、协议错误、客户端冒烟。
import { afterAll, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { buildReplyOK, bytesOf, concatFrame } from './helpers.js';
import {
  MsgType,
  NetworkError,
  ProtocolError,
  WithHeartbeatInterval,
  readFrameFrom,
  encodeFrame,
  buildRequestBody,
  type Header,
} from '../src/index.js';
import { dialTCP, newTCPClient } from '../src/node.js';


let server: net.Server | null = null;
const servers: net.Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

/** 起一个 TCP 测试服务端：onFrame 收到客户端请求帧后按 handler 回帧；
 * onConnect 在客户端连接建立时回调（server 主动写场景用于捕获 socket）。 */
async function startServer(
  onFrame: (frame: { header: Header; body: Uint8Array }, socket: net.Socket) => void,
  onConnect?: (socket: net.Socket) => void,
): Promise<number> {
  const s = net.createServer((socket) => {
    onConnect?.(socket);
    let buf = new Uint8Array(0);
    socket.on('data', (chunk: Buffer) => {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf);
      merged.set(chunk, buf.length);
      buf = merged;
      for (;;) {
        const r = readFrameFrom(buf, 0);
        if (!r.ok) break;
        buf = buf.subarray(r.consumed);
        onFrame({ header: r.header, body: r.body }, socket);
      }
    });
  });
  servers.push(s);
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
  });
}

/** 等 server 侧 socket 捕获就绪（server 'connection' 与客户端 connect resolve 的时序竞态）。 */
async function waitForSock(sock: () => net.Socket | null): Promise<void> {
  for (let i = 0; i < 200 && sock() === null; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (sock() === null) throw new Error('server socket 未就绪');
}

describe('dialTCP 传输层', () => {
  it('往返：请求帧 → 服务端回响应帧', async () => {
    const port = await startServer((frame, socket) => {
      socket.write(encodeFrame({ magic: 0, version: 0, type: MsgType.Response, seq: frame.header.seq, length: 0 }, buildReplyOK(bytesOf('{"ok":1}')), 0));
    });
    const tr = await dialTCP({ kind: 'tcp', addr: `127.0.0.1:${port}` });
    await tr.writeFrame(
      { magic: 0, version: 0, type: MsgType.Request, seq: 7, length: 0 },
      buildRequestBody('/op', bytesOf('{}')),
      0,
    );
    const { header, body } = await tr.readFrame(0);
    expect(header.seq).toBe(7);
    expect(body).toEqual(buildReplyOK(bytesOf('{"ok":1}')));
    await tr.close();
  });

  it('粘包：一次写入两帧 → 两次 readFrame 各得其一', async () => {
    let sock: net.Socket | null = null;
    const port = await startServer(() => {}, (socket) => {
      sock ??= socket;
    });
    const tr = await dialTCP({ kind: 'tcp', addr: `127.0.0.1:${port}` });
    const f1 = encodeFrame({ magic: 0, version: 0, type: MsgType.Notify, seq: 1, length: 0 }, buildRequestBody('/a', bytesOf('x')), 0);
    const f2 = encodeFrame({ magic: 0, version: 0, type: MsgType.Notify, seq: 2, length: 0 }, buildRequestBody('/b', bytesOf('yy')), 0);
    await waitForSock(() => sock);
    sock!.write(concatFrameBytes(f1, f2)); // 粘包：一次 write 两帧
    const r1 = await tr.readFrame(0);
    const r2 = await tr.readFrame(0);
    expect(r1.header.seq).toBe(1);
    expect(r2.header.seq).toBe(2);
    await tr.close();
  });

  it('半包：头先到 body 后到 → readFrame 得完整帧', async () => {
    let sock: net.Socket | null = null;
    const port = await startServer(() => {}, (socket) => {
      sock ??= socket;
    });
    const tr = await dialTCP({ kind: 'tcp', addr: `127.0.0.1:${port}` });
    const frame = encodeFrame({ magic: 0, version: 0, type: MsgType.Notify, seq: 3, length: 0 }, buildRequestBody('/op', bytesOf('payload')), 0);
    await waitForSock(() => sock);
    const p = tr.readFrame(0);
    sock!.write(frame.subarray(0, 10)); // 先到 10 字节（不足整帧）
    await new Promise((r) => setTimeout(r, 20));
    sock!.write(frame.subarray(10)); // 半包补齐
    const r = await p;
    expect(r.header.seq).toBe(3);
    expect(r.body).toEqual(buildRequestBody('/op', bytesOf('payload')));
    await tr.close();
  });

  it('服务端断连 → readFrame reject NetworkError', async () => {
    let sock: net.Socket | null = null;
    const port = await startServer(() => {}, (socket) => {
      sock ??= socket;
    });
    const tr = await dialTCP({ kind: 'tcp', addr: `127.0.0.1:${port}` });
    await waitForSock(() => sock);
    const p = tr.readFrame(0);
    sock!.destroy();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    await tr.close();
  });

  it('协议错误（垃圾字节帧）→ readFrame reject ProtocolError', async () => {
    let sock: net.Socket | null = null;
    const port = await startServer(() => {}, (socket) => {
      sock ??= socket;
    });
    const tr = await dialTCP({ kind: 'tcp', addr: `127.0.0.1:${port}` });
    await waitForSock(() => sock);
    const p = tr.readFrame(0);
    sock!.write(bytesOf('this is garbage bytes over 16B!!'));
    await expect(p).rejects.toBeInstanceOf(ProtocolError);
    await tr.close();
  });
});

describe('newTCPClient 客户端冒烟', () => {
  it('invoke 往返 + Notify 订阅（真实 TCP 回环）', async () => {
    let notifySent = false;
    const port = await startServer((frame, socket) => {
      if (frame.header.type !== MsgType.Request) return;
      const opLen = ((frame.body[0] ?? 0) << 8) | (frame.body[1] ?? 0);
      const op = new TextDecoder().decode(frame.body.subarray(2, 2 + opLen));
      socket.write(encodeFrame({ magic: 0, version: 0, type: MsgType.Response, seq: frame.header.seq, length: 0 }, buildReplyOK(bytesOf('{"echo":"' + op + '"}')), 0));
      if (!notifySent) {
        notifySent = true;
        socket.write(encodeFrame({ magic: 0, version: 0, type: MsgType.Notify, seq: 500, length: 0 }, buildRequestBody('/notify', bytesOf('push')), 0));
      }
    });
    const c = await newTCPClient(`127.0.0.1:${port}`, [WithHeartbeatInterval(0)]);
    const got: string[] = [];
    c.on('/notify', (_op, p) => void got.push(new TextDecoder().decode(p)));
    await new Promise((r) => setTimeout(r, 10));
    const resp = (await c.invoke('/login', null)) as { echo: string };
    expect(resp).toEqual({ echo: '/login' });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['push']);
    await c.close();
  });
});

function concatFrameBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

