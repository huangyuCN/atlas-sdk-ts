// WebSocket 通道测试：open 等待/超时、一消息一帧、文本帧终止、断连、写帧、客户端冒烟。
import { describe, expect, it } from 'vitest';
import { buildReplyOK, bytesOf, concatFrame } from './helpers.js';
import {
  buildRequestBody,
  connectWebSocketTransport,
  decodeFrame,
  encodeFrame,
  MsgType,
  NetworkError,
  ProtocolError,
  readFrameFrom,
  newWSClient,
  HeartbeatOperation,
  WithHeartbeatInterval,
  type WebSocketLike,
} from '../src/index.js';

/** mock WS：on* 事件由测试侧手动触发（serverOpen/serverMessage/serverClose）。 */
class MockWebSocket implements WebSocketLike {
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  closedBySdk = false;
  /** 服务端侧帧处理器：客户端 send 时回调（模拟网关收帧），不占用 onmessage。 */
  serverOnFrame: ((frame: Uint8Array) => void) | null = null;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  serverOpen(): void {
    this.onopen?.();
  }

  serverMessage(frame: Uint8Array): void {
    // 浏览器 arraybuffer 形态：data 为 ArrayBuffer
    this.onmessage?.({ data: frame.slice().buffer });
  }

  serverText(text: string): void {
    this.onmessage?.({ data: text });
  }

  serverClose(): void {
    this.onclose?.();
  }

  send(data: ArrayBuffer | Uint8Array): void {
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.sent.push(frame);
    this.serverOnFrame?.(frame);
  }

  close(): void {
    this.closedBySdk = true;
    this.serverClose();
  }
}

describe('connectWebSocketTransport', () => {
  it('open 后返回 transport；一消息一帧（ArrayBuffer 形态）', async () => {
    const ws = new MockWebSocket();
    const pending = connectWebSocketTransport(ws);
    ws.serverOpen();
    const tr = await pending;
    const frame = concatFrame(MsgType.Notify, 9, buildRequestBody('/op', bytesOf('x')));
    ws.serverMessage(frame);
    const { header, body } = await tr.readFrame(0);
    expect(header.type).toBe(MsgType.Notify);
    expect(header.seq).toBe(9);
    expect(body).toEqual(buildRequestBody('/op', bytesOf('x')));
    await tr.close();
  });

  it('握手超时：未 open 则 reject NetworkError', async () => {
    const ws = new MockWebSocket();
    await expect(connectWebSocketTransport(ws, 20)).rejects.toBeInstanceOf(NetworkError);
  });

  it('文本消息 → ProtocolError（协议要求二进制帧）', async () => {
    const ws = new MockWebSocket();
    const pending = connectWebSocketTransport(ws);
    ws.serverOpen();
    const tr = await pending;
    ws.serverText('not-binary');
    await expect(tr.readFrame(0)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('server 关闭 → readFrame reject NetworkError', async () => {
    const ws = new MockWebSocket();
    const pending = connectWebSocketTransport(ws);
    ws.serverOpen();
    const tr = await pending;
    const p = tr.readFrame(0);
    ws.serverClose();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
  });

  it('writeFrame 整帧发送（服务端可解码）', async () => {
    const ws = new MockWebSocket();
    const pending = connectWebSocketTransport(ws);
    ws.serverOpen();
    const tr = await pending;
    const body = buildRequestBody('/op', bytesOf('{}'));
    await tr.writeFrame({ magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 }, body, 0);
    expect(ws.sent.length).toBe(1);
    const { header, body: got } = decodeFrame(ws.sent[0]!, 0);
    expect(header.type).toBe(MsgType.Request);
    expect(got).toEqual(body);
    await tr.close();
  });
});

describe('newWSClient 客户端冒烟', () => {
  it('invoke 往返 + Notify 订阅（mock WS 服务端）', async () => {
    let ws: MockWebSocket | null = null;
    const c = await newWSClient(
      'ws://mock:9002/ws',
      [WithHeartbeatInterval(0)], // 关闭心跳避免干扰
      () => {
        ws = new MockWebSocket();
        queueMicrotask(() => ws!.serverOpen());
        return ws;
      },
    );
    const server = ws!;
    // 服务端帧处理（挂在 send 侧）：请求 → 回成功包络
    server.serverOnFrame = (frame) => {
      const r = readFrameFrom(frame, 0);
      if (!r.ok || r.header.type !== MsgType.Request) return;
      server.serverMessage(
        concatFrame(MsgType.Response, r.header.seq, buildReplyOK(bytesOf('{"ok":true}'))),
      );
    };
    const got: string[] = [];
    const off = c.on('/notify', (_op, p) => void got.push(new TextDecoder().decode(p)));
    server.serverMessage(concatFrame(MsgType.Notify, 100, buildRequestBody('/notify', bytesOf('hello'))));
    await new Promise((r) => setTimeout(r, 10));
    const resp = (await c.invoke('/login', { a: 1 })) as { ok: boolean };
    expect(resp).toEqual({ ok: true });
    expect(got).toEqual(['hello']);
    off();
    await c.close();
    expect((ws as MockWebSocket | null)!.closedBySdk).toBe(true);
  });
});

