// Session 集成测试（与 Go client/session_test.go 同构）：会话槽编解码已在
// frame/body 单测覆盖，此处验证凭据流转语义——登录保管凭据 / 无凭据 Resume 报错
// 且不发网络请求 / UDP 业务请求帧携带会话槽（搭真实 UDP 假服务端，本地回环无外部依赖）。
//
// op 名、请求/回执字段与版本字段一律取自生成物（模板会话 stub 快照 + src/version.ts），
// 测试内不写字面量——手写副本漂移会在这里直接暴露。
import { afterAll, describe, expect, it } from 'vitest';
import * as dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { buildReplyOK, bytesOf, gatewayV1Protocol, waitFor } from './helpers.js';
import { MsgType, buildRequestBody, decodeFrame, encodeFrame, parseRequestBodyWithSession } from '../src/frame/index.js';
import { newUDPClient } from '../src/node.js';
import {
  CLIENT_VERSION,
  WithHeartbeatInterval,
  WithSessionHeartbeatInterval,
  newSession,
  withSessionProtocol,
} from '../src/index.js';
import {
  SessionProtocolOps,
  sessionPushOps,
  type LoginReply,
  type LoginRequest,
  type ResumeRequest,
} from '../src/gen/api/gateway/v1/opclient/session_pb.js';

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

/** SessionTestServer 是会话测试服务端记录面：最近一条与全量 "op|session" 记录，
 * 以及各请求的原始 JSON 载荷（版本上报断言用）。 */
interface SessionTestServer {
  port: number;
  /** 最近一条 "op|session" 记录（无请求为空串）。 */
  lastSeen(): string;
  /** 全部 "op|session" 记录（按到达序）。 */
  seenAll(): string[];
  /** 某 op 最近一次请求载荷的 JSON 对象（无记录为 null）。 */
  lastReq(op: string): Record<string, unknown> | null;
  /** 向最近一次请求的来源回推一条 Notify 帧（被挤下线推送用例）。 */
  notify(op: string, payload: unknown): void;
}

/** startSessionServer 起一个会话测试服务端（UDP）：按 op 回预置 JSON 回执，并
 * 记录每次请求的 "op|session" 与载荷——供会话槽与凭据流转断言。 */

async function startSessionServer(): Promise<SessionTestServer> {
  const replies: Record<string, Record<string, string>> = {
    [SessionProtocolOps.login]: { playerId: '42', token: 'tok-42' },
    [SessionProtocolOps.resume]: { playerId: '42', token: 'tok-42' },
    [SessionProtocolOps.logout]: {},
  };
  const seen: string[] = [];
  const reqs = new Map<string, Record<string, unknown>>();
  let lastRinfo: { port: number; address: string } | null = null;
  const s = dgram.createSocket('udp4');
  servers.push(s);
  s.on('message', (msg: Buffer, rinfo) => {
    // 坏帧静默丢弃（对齐 Go sessionTestServer 的 continue 语义）。
    try {
      const f = decodeFrame(new Uint8Array(msg), 0);
      const { operation, session, payload } = parseRequestBodyWithSession(
        f.body,
        f.header.flags ?? 0,
      );
      seen.push(`${operation}|${session}`);
      reqs.set(operation, JSON.parse(new TextDecoder().decode(payload) || '{}') as Record<string, unknown>);
      lastRinfo = { port: rinfo.port, address: rinfo.address };
      const data = bytesOf(JSON.stringify(replies[operation] ?? {}));
      // 响应包络：[hasError=0][dataLen:u32][data]（decodeReply 对应格式）。
      const reply = encodeFrame(
        { magic: 0, version: 0, type: MsgType.Response, seq: f.header.seq, length: 0 },
        buildReplyOK(data),
        0,
      );
      s.send(reply, rinfo.port, rinfo.address);
    } catch {
      // 非法帧：跳过不回
    }
  });
  await new Promise<void>((resolve) => {
    s.bind(0, '127.0.0.1', () => resolve());
  });
  const port = (s.address() as AddressInfo).port;
  return {
    port,
    lastSeen: () => seen[seen.length - 1] ?? '',
    seenAll: () => seen,
    lastReq: (op) => reqs.get(op) ?? null,
    notify: (op, payload) => {
      if (!lastRinfo) return;
      const frame = encodeFrame(
        { magic: 0, version: 0, type: MsgType.Notify, seq: 1, length: 0 },
        buildRequestBody(op, bytesOf(JSON.stringify(payload))),
        0,
      );
      s.send(frame, lastRinfo.port, lastRinfo.address);
    },
  };
}

/** dialSessionClient 拨号 UDP 客户端并装配 Session（接缝取自模板生成素材；
 * 传输心跳关闭；会话心跳周期由用例自定）。 */
async function dialSessionClient(srv: SessionTestServer, heartbeatIntervalMs = 0) {
  const s = newSession([
    withSessionProtocol(gatewayV1Protocol()),
    WithSessionHeartbeatInterval(heartbeatIntervalMs),
  ]);
  const cli = await newUDPClient(`127.0.0.1:${srv.port}`, [
    WithHeartbeatInterval(0),
    ...s.channelOptions(),
  ]);
  s.bind(cli);
  return { s, cli };
}

// TestSessionLoginStoresToken 同构：登录后凭据被保管、Logout 后清空。
describe('Session 凭据保管', () => {
  it('登录后凭据被保管，登出后清空', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);

    const reply = (await s.login({ playerId: '42', password: 'x' })) as LoginReply;
    expect(reply.token).toBe('tok-42');
    expect(s.token()).toBe('tok-42');
    expect(s.playerId()).toBe('42');

    await s.logout();
    expect(s.token()).toBe('');
    expect(s.playerId()).toBe('');

    await cli.close();
  });

  it('登录请求本身为匿名帧（凭据为空不置位会话槽）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await s.login({ playerId: '42', password: 'x' });
    await waitFor(() => srv.lastSeen().startsWith(`${SessionProtocolOps.login}|`));
    expect(srv.lastSeen()).toBe(`${SessionProtocolOps.login}|`);
    await cli.close();
  });

  it('无凭据 Resume 报错且不发网络请求（TestSessionResumeRequiresToken 同构）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await expect(s.resume()).rejects.toThrow(/无会话凭据/);
    expect(srv.seenAll().length).toBe(0);
    await cli.close();
  });
});

// 版本上报（M1）：登录与恢复请求都带 client_version，值取自 src/version.ts 单一来源。
describe('客户端版本上报', () => {
  it('Login 请求带 clientVersion（字段名取自生成 DTO，值取自单一来源）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await s.login({ playerId: '42', password: 'x' });

    const req = srv.lastReq(SessionProtocolOps.login) as LoginRequest | null;
    expect(req?.clientVersion).toBe(CLIENT_VERSION);
    expect(req?.playerId).toBe('42');
    expect(CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    await cli.close();
  });

  it('Resume 请求带 clientVersion（凭据 + 版本一起复述）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await s.login({ playerId: '42', password: 'x' });
    await s.resume();

    const req = srv.lastReq(SessionProtocolOps.resume) as ResumeRequest | null;
    expect(req?.clientVersion).toBe(CLIENT_VERSION);
    expect(req?.token).toBe('tok-42');
    await cli.close();
  });
});

// 被挤下线推送（P4 新增能力）：原因从推送载荷提取，凭据随即清空。
describe('Session 被挤下线推送', () => {
  it('收到 KickedNotify：清空凭据并记录原因（op 与原因均取自生成物/接缝）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await s.login({ playerId: '42', password: 'x' });
    expect(s.token()).toBe('tok-42');

    srv.notify(sessionPushOps.kickedNotify, { reason: 'KICKED_REASON_LOGGED_IN_ELSEWHERE' });
    await waitFor(() => s.token() === '');
    expect(s.playerId()).toBe('');
    expect(s.kickedReason()).toBe('KICKED_REASON_LOGGED_IN_ELSEWHERE');
    await cli.close();
  });

  it('非会话推送不影响凭据（接缝按 op 判定）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await s.login({ playerId: '42', password: 'x' });

    srv.notify('/game.v1.PlayerService/Notify', { reason: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.token()).toBe('tok-42');
    expect(s.kickedReason()).toBe('');
    await cli.close();
  });
});

// TestUDPSessionSlotCarriedOnInvoke 同构：无连接传输的请求帧携带会话槽——
// 登录后凭据被保管，随后的业务 Invoke（无身份字段的消息）经帧槽携带凭据。
describe('UDP 会话槽装配', () => {
  it('登录后业务请求帧携带会话槽凭据', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);

    await s.login({ playerId: '42', password: 'x' });
    await cli.invoke('/game.v1.PlayerService/GetPlayer', null);
    await waitFor(() => srv.lastSeen().startsWith('/game.v1.PlayerService/GetPlayer|tok-42'));
    await cli.close();
  });

  it('未登录发匿名帧：请求不携带会话槽（凭据为空不置位）', async () => {
    const srv = await startSessionServer();
    const { s, cli } = await dialSessionClient(srv);
    await cli.invoke('/game.v1.PlayerService/GetPlayer', null);
    await waitFor(() => srv.lastSeen().startsWith('/game.v1.PlayerService/GetPlayer|'));
    expect(srv.lastSeen()).toBe('/game.v1.PlayerService/GetPlayer|');
    expect(s.token()).toBe('');
    await cli.close();
  });
});

describe('Session 内置会话心跳', () => {
  it('已登录时按周期发会话心跳（无 payload）且携带会话槽；登出后凭据为空，不再有带凭据心跳', async () => {
    const srv = await startSessionServer();
    // 会话心跳周期 20ms（远小于 30s 默认传输心跳；传输心跳已单独关闭）。
    const { s, cli } = await dialSessionClient(srv, 20);

    await s.login({ playerId: '42', password: 'x' });
    await waitFor(() => srv.lastSeen().startsWith(`${SessionProtocolOps.heartbeat}|tok-42`));

    await s.logout();
    // 登出后无凭据：心跳工厂返回 null 跳过本轮；在途的最后一轮心跳也按发送时刻
    // 读凭据（可能为匿名帧），不再出现携带 tok-42 的心跳记录。
    const records = srv.seenAll();
    const logoutIdx = records.findIndex((r) => r.startsWith(`${SessionProtocolOps.logout}|`));
    for (const rec of records.slice(logoutIdx + 1)) {
      expect(rec.startsWith(`${SessionProtocolOps.heartbeat}|tok-42`)).toBe(false);
    }
    await cli.close();
  });
});
