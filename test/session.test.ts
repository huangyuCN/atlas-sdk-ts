// Session 集成测试（与 Go client/session_test.go 同构）：会话槽编解码已在
// frame/body 单测覆盖，此处验证凭据流转语义——登录保管凭据 / 无凭据 Resume 报错
// 且不发网络请求 / UDP 业务请求帧携带会话槽（搭真实 UDP 假服务端，本地回环无外部依赖）。
import { afterAll, describe, expect, it } from 'vitest';
import * as dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { buildReplyOK, bytesOf, waitFor } from './helpers.js';
import { MsgType, decodeFrame, encodeFrame, parseRequestBodyWithSession } from '../src/frame/index.js';
import { newUDPClient } from '../src/node.js';
import {
  OpSessionHeartbeat,
  OpSessionLogin,
  OpSessionLogout,
  OpSessionResume,
  WithHeartbeatInterval,
  WithSessionHeartbeatInterval,
  newSession,
} from '../src/index.js';

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

/** SessionTestServer 是会话测试服务端记录面：最近一条与全量 "op|session" 记录。 */
interface SessionTestServer {
  port: number;
  /** 最近一条 "op|session" 记录（无请求为空串）。 */
  lastSeen(): string;
  /** 全部 "op|session" 记录（按到达序）。 */
  seenAll(): string[];
}

/** startSessionServer 起一个会话测试服务端（UDP）：按 op 回预置 JSON 回执，并
 * 记录每次请求的 "op|session"——供会话槽与凭据流转断言。 */

async function startSessionServer(): Promise<SessionTestServer> {
  const replies: Record<string, Record<string, string>> = {
    [OpSessionLogin]: { playerId: '42', token: 'tok-42' },
    [OpSessionResume]: { playerId: '42', token: 'tok-42' },
    [OpSessionLogout]: {},
  };
  const seen: string[] = [];
  const s = dgram.createSocket('udp4');
  servers.push(s);
  s.on('message', (msg: Buffer, rinfo) => {
    // 坏帧静默丢弃（对齐 Go sessionTestServer 的 continue 语义）。
    try {
      const f = decodeFrame(new Uint8Array(msg), 0);
      const { operation, session } = parseRequestBodyWithSession(f.body, f.header.flags ?? 0);
      seen.push(`${operation}|${session}`);
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
  };
}

/** dialSessionClient 拨号 UDP 客户端并装配 Session（传输心跳关闭；会话心跳周期由用例自定）。 */
async function dialSessionClient(srv: SessionTestServer, heartbeatIntervalMs = 0) {
  const s = newSession([WithSessionHeartbeatInterval(heartbeatIntervalMs)]);
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

    const reply = await s.login({ playerId: '42', password: 'x' });
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
    await waitFor(() => srv.lastSeen().startsWith(`${OpSessionLogin}|`));
    expect(srv.lastSeen()).toBe(`${OpSessionLogin}|`);
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
    await waitFor(() => srv.lastSeen().startsWith(`${OpSessionHeartbeat}|tok-42`));

    await s.logout();
    // 登出后无凭据：心跳工厂返回 null 跳过本轮；在途的最后一轮心跳也按发送时刻
    // 读凭据（可能为匿名帧），不再出现携带 tok-42 的心跳记录。
    const records = srv.seenAll();
    const logoutIdx = records.findIndex((r) => r.startsWith(`${OpSessionLogout}|`));
    for (const rec of records.slice(logoutIdx + 1)) {
      expect(rec.startsWith(`${OpSessionHeartbeat}|tok-42`)).toBe(false);
    }
    await cli.close();
  });
});
