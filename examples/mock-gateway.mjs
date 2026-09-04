// mock-gateway：本地 TCP mock 网关（examples/smoke.mjs 的脚本逻辑验证用）。
// 按 smoke 协议回包：Register / Login / Heartbeat / 内置 Ping。
// 用法：node examples/mock-gateway.mjs [port]（默认 19001）
import * as net from 'node:net';
import { readFrameFrom, encodeFrame, MsgType } from '../dist/index.js';

/** 成功响应包络：[hasError=0][dataLen:u32][data]（响应帧 body 直连包络，无 op 头）。
 * 入参为已编码的 payload 字节（注意不要再 stringify——Uint8Array 会被展开成数字键）。 */
const buildReplyOK = (data) => {
  const out = new Uint8Array(5 + data.length);
  out[0] = 0;
  new DataView(out.buffer).setUint32(1, data.length);
  out.set(data, 5);
  return out;
};

const port = Number(process.argv[2] ?? 19001);

const op = {
  register: '/gateway.v1.GatewayAuth/Register',
  login: '/gateway.v1.GatewayAuth/Login',
  heartbeat: '/gateway.v1.GatewayAuth/Heartbeat',
};

function reply(seq, payload) {
  return encodeFrame(
    { magic: 0, version: 0, type: MsgType.Response, seq, length: 0 },
    buildReplyOK(new TextEncoder().encode(JSON.stringify(payload))),
    0,
  );
}

const server = net.createServer((socket) => {
  let buf = new Uint8Array(0);
  socket.on('data', (chunk) => {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    for (;;) {
      const r = readFrameFrom(buf, 0);
      if (!r.ok) break;
      buf = buf.subarray(r.consumed);
      handle(r.header, r.body, socket);
    }
  });
});

function handle(header, body, socket) {
  if (header.type !== MsgType.Request) return;
  const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
  const operation = new TextDecoder().decode(body.subarray(2, 2 + opLen));
  const payload = JSON.parse(new TextDecoder().decode(body.subarray(2 + opLen)) || '{}');
  switch (operation) {
    case op.register: {
      socket.write(reply(header.seq, { playerId: 'mock-' + payload.account }));
      break;
    }
    case op.login: {
      socket.write(reply(header.seq, { playerId: payload.playerId, token: 'mock-token-' + Date.now() }));
      break;
    }
    case op.heartbeat:
      socket.write(reply(header.seq, { ok: true }));
      break;
    default:
      socket.write(reply(header.seq, { ok: true, echo: operation }));
  }
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-gateway] 监听 127.0.0.1:${port}`);
});
