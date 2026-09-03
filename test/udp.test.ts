// Node UDP 通道回环测试（真实 socket，本地回环无外部依赖）：
// 往返、坏数据报静默丢弃、64KiB 写侧拦截、客户端冒烟。
import { afterAll, describe, expect, it } from 'vitest';
import * as dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { buildReplyOK, bytesOf } from './helpers.js';
import {
  buildRequestBody,
  MsgType,
  ProtocolError,
  WithHeartbeatInterval,
  encodeFrame,
  readFrameFrom,
  type Header,
} from '../src/index.js';
import { dialUDP, newUDPClient, UDP_MAX_DATAGRAM } from '../src/node.js';

const servers: dgram.Socket[] = [];

afterAll(() => {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      // 已关闭
    }
  }
});

/** 起一个 UDP 测试服务端：每个客户端报文回调 handler，回帧经 socket.send。 */
async function startServer(onFrame: (frame: { header: Header; body: Uint8Array }, reply: (frame: Uint8Array) => void) => void): Promise<number> {
  const s = dgram.createSocket('udp4');
  servers.push(s);
  s.on('message', (msg: Buffer, rinfo) => {
    const r = readFrameFrom(new Uint8Array(msg), 0);
    if (!r.ok) return;
    onFrame({ header: r.header, body: r.body }, (frame) => {
      s.send(frame, rinfo.port, rinfo.address);
    });
  });
  await new Promise<void>((resolve) => {
    s.bind(0, '127.0.0.1', () => resolve());
  });
  return (s.address() as AddressInfo).port;
}

describe('dialUDP 传输层', () => {
  it('往返：请求帧 → 服务端回响应帧', async () => {
    const port = await startServer((frame, reply) => {
      reply(encodeFrame({ magic: 0, version: 0, type: MsgType.Response, seq: frame.header.seq, length: 0 }, buildReplyOK(bytesOf('{"ok":1}')), 0));
    });
    const tr = await dialUDP({ kind: 'udp', addr: `127.0.0.1:${port}` });
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

  it('坏数据报静默丢弃：垃圾报文后的合法帧仍可读', async () => {
    let sock: dgram.Socket | null = null;
    let clientAddr: AddressInfo | null = null;
    const s = dgram.createSocket('udp4');
    servers.push(s);
    s.on('message', (msg: Buffer, rinfo) => {
      clientAddr ??= rinfo;
      const r = readFrameFrom(new Uint8Array(msg), 0);
      if (!r.ok) return;
      // 先发垃圾报文（坏数据报），再发合法帧——客户端应只看到合法帧
      s.send(bytesOf('garbage-not-a-frame-bytes!!'), rinfo.port, rinfo.address);
      s.send(
        encodeFrame({ magic: 0, version: 0, type: MsgType.Notify, seq: 5, length: 0 }, buildRequestBody('/n', bytesOf('x')), 0),
        rinfo.port,
        rinfo.address,
      );
    });
    await new Promise<void>((resolve) => {
      s.bind(0, '127.0.0.1', () => resolve());
    });
    const port = (s.address() as AddressInfo).port;
    const tr = await dialUDP({ kind: 'udp', addr: `127.0.0.1:${port}` });
    await tr.writeFrame(
      { magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 },
      buildRequestBody('/trigger', new Uint8Array(0)),
      0,
    );
    const { header } = await tr.readFrame(0);
    expect(header.seq).toBe(5); // 垃圾报文被吞，只读到合法帧
    await tr.close();
    void sock;
    void clientAddr;
  });

  it('写侧 64KiB（含帧头）拦截 → ProtocolError', async () => {
    const port = await startServer(() => {});
    const tr = await dialUDP({ kind: 'udp', addr: `127.0.0.1:${port}` });
    const big = new Uint8Array(UDP_MAX_DATAGRAM); // body = 64KiB，加 16B 头即超限
    await expect(
      tr.writeFrame({ magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 }, big, 0),
    ).rejects.toBeInstanceOf(ProtocolError);
    await tr.close();
  });
});

describe('newUDPClient 客户端冒烟', () => {
  it('readFrame 自定义 maxBodySize 生效：超限数据报软跳过（评审 Fix：此前固定 0 解码绕过上限）', async () => {
    const port = await startServer((frame, reply) => {
      // 回一个大 body 帧（超过调用方将设的 8B 上限）
      reply(encodeFrame({ magic: 0, version: 0, type: MsgType.Response, seq: frame.header.seq, length: 0 }, bytesOf('abcdefghij'), 0));
    });
    const tr = await dialUDP({ kind: 'udp', addr: `127.0.0.1:${port}` });
    await tr.writeFrame({ magic: 0, version: 0, type: MsgType.Request, seq: 5, length: 0 }, bytesOf(''), 0);
    // 8B 上限：服务端回的 10B body 帧超限，readFrame 应软跳过并继续阻塞等待
    // （不得因超限抛错也不得返回超限帧）。
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('readFrame 应阻塞等待合法帧')), 300));
    const p = tr.readFrame(8);
    await expect(Promise.race([p, timeout])).rejects.toThrow(/阻塞等待/);
    await tr.close();
  });

  it('readFrame 正常帧按自定义 maxBodySize 解码（评审 Fix）', async () => {
    const port = await startServer((frame, reply) => {
      reply(encodeFrame({ magic: 0, version: 0, type: MsgType.Response, seq: frame.header.seq, length: 0 }, bytesOf('ok'), 0));
    });
    const tr = await dialUDP({ kind: 'udp', addr: `127.0.0.1:${port}` });
    await tr.writeFrame({ magic: 0, version: 0, type: MsgType.Request, seq: 6, length: 0 }, bytesOf(''), 0);
    const res = await tr.readFrame(8); // 上限 8B > 2B body：正常解码
    expect(res.header.seq).toBe(6);
    expect(res.body).toEqual(bytesOf('ok'));
    await tr.close();
  });

  it('invoke 往返（真实 UDP 回环）', async () => {
    const port = await startServer((frame, reply) => {
      if (frame.header.type !== MsgType.Request) return;
      const opLen = ((frame.body[0] ?? 0) << 8) | (frame.body[1] ?? 0);
      const op = new TextDecoder().decode(frame.body.subarray(2, 2 + opLen));
      reply(encodeFrame({ magic: 0, version: 0, type: MsgType.Response, seq: frame.header.seq, length: 0 }, buildReplyOK(bytesOf('{"echo":"' + op + '"}')), 0));
    });
    const c = await newUDPClient(`127.0.0.1:${port}`, [WithHeartbeatInterval(0)]);
    const resp = (await c.invoke('/battle/v1.Join', null)) as { echo: string };
    expect(resp).toEqual({ echo: '/battle/v1.Join' });
    await c.close();
  });
});
