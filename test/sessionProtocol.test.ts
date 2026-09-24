// SessionProtocol 接缝契约测试（S0.5 冻结形状：5 个 op + 3 个解码钩子 + 1 个推送识别；
// 修订 1：推送识别的载荷是**推送信封** PushEnvelope{op,version,body}）。
//
// 接缝是「会话状态机」与「会话消息类型」之间的唯一缝：注入 fake 接缝即可驱动
// 登录/心跳/被踢，无需任何真实会话 DTO；生成物侧素材（模板 stub 快照）另有用例锁定。
// 与 atlas-sdk-go/client/session_protocol_test.go、atlas-sdk-csharp SessionProtocolTest
// 同构（三语言同职责、命名按各语言惯用）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  Kind,
  SessionReplyUnresolvedError,
  WithSessionHeartbeatInterval,
  newClient,
  newSession,
  withSessionProtocol,
  type PushEnvelope,
  type SessionProtocol,
} from '../src/index.js';
import { buildReplyOK, bytesOf, gatewayV1Protocol, makeDialer, newKickedBody, waitFor } from './helpers.js';
import {
  SessionProtocolOps,
  sessionPlayerID,
  sessionExpiresAt,
  sessionPushOps,
  sessionToken,
} from '../src/gen/api/gateway/v1/opclient/session_pb.js';
import { KickedReason, LoginReplySchema } from '../examples/gen/api/gateway/v1/session_pb.js';
import { kickedNotifyOp, newGatewayV1SessionProtocol } from '../examples/gatewayv1.mjs';

/** fakeProtocol 是纯 fake 接缝：op 名与钩子返回值都与任何真实 DTO 无关。 */
function fakeProtocol(): SessionProtocol {
  return {
    ops: () => ({
      register: '/fake/Register',
      login: '/fake/Login',
      resume: '/fake/Resume',
      logout: '/fake/Logout',
      heartbeat: '/fake/Heartbeat',
    }),
    token: () => 'fake-token',
    playerID: () => 'fake-player',
    expiresAt: () => 1_700_000_000_000,
    kicked: (op, env) =>
      op === '/fake/Kicked'
        ? { reason: new TextDecoder().decode(env.body), ok: true }
        : { reason: '', ok: false },
  };
}

/** dialFake 拨号内存 mock 通道并装配接缝 Session；返回服务端模拟器、Client 与收到的 op 记录。 */
async function dialFake(
  opts: { protocol?: SessionProtocol; heartbeatMs?: number } = {},
): Promise<{
  session: ReturnType<typeof newSession>;
  cli: Awaited<ReturnType<typeof newClient>>;
  close: () => Promise<void>;
  seen: string[];
  servers: ReturnType<typeof makeDialer>['servers'];
}> {
  const seen: string[] = [];
  const { dialer, servers } = makeDialer((server) =>
    server.autoReply((op) => {
      seen.push(op);
      return buildReplyOK(bytesOf('{}'));
    }),
  );
  const session = newSession([
    withSessionProtocol(opts.protocol ?? fakeProtocol()),
    WithSessionHeartbeatInterval(opts.heartbeatMs ?? 0),
  ]);
  const cli = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, [
    ...session.channelOptions(),
  ]);
  session.bind(cli);
  return { session, cli, close: () => cli.close(), seen, servers };
}

/** dialFakeClient 另起一个独立 mock 通道（重绑订阅用例：旧/新 Client 各一条连接）。 */
async function dialFakeClient(): Promise<{
  cli: Awaited<ReturnType<typeof newClient>>;
  close: () => Promise<void>;
  servers: ReturnType<typeof makeDialer>['servers'];
}> {
  const { dialer, servers } = makeDialer();
  const cli = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, []);
  return { cli, close: () => cli.close(), servers };
}

describe('SessionProtocol 接缝：形状与生成物素材', () => {
  it('接缝成员集合与 S0.5 冻结表一致（5 op + 3 解码钩子 + 1 推送识别）', () => {
    const p = gatewayV1Protocol();
    // 形状冻结：三仓不得各自加字段（成员名与职责一一对应）。
    expect(Object.keys(p).sort()).toEqual(['expiresAt', 'kicked', 'ops', 'playerID', 'token']);
    expect(Object.keys(p.ops()).sort()).toEqual([
      'heartbeat',
      'login',
      'logout',
      'register',
      'resume',
    ]);
    // 类型层面同样冻结：多一个成员即编译失败（satisfies 检查成员集合）。
    const shape = {
      ops: () => SessionProtocolOps,
      token: (msg: unknown) => sessionToken(msg),
      playerID: (msg: unknown) => sessionPlayerID(msg),
      expiresAt: (msg: unknown) => sessionExpiresAt(msg),
      kicked: (op: string, env: PushEnvelope) => ({ reason: op + String(env.version), ok: false }),
    } satisfies SessionProtocol;
    expect(Object.keys(shape).length).toBe(5);
  });

  it('op 名与推送 op 来自模板生成的会话 stub 快照', () => {
    const p = gatewayV1Protocol();
    expect(p.ops()).toBe(SessionProtocolOps);
    expect(p.ops().login).toBe('/gateway.v1.Session/Login');
    expect(sessionPushOps.kickedNotify).toBe('/gateway.v1.KickedNotify');
    // 生成物 op 名即 service/rpc 全名（客户端 op 寻址键）
    expect(p.ops().register.endsWith('/Register')).toBe(true);
    expect(p.ops().heartbeat.endsWith('/Heartbeat')).toBe(true);
  });

  it('生成物解码钩子：命中字段取值，未知/空载荷返回零值不抛错', () => {
    const p = gatewayV1Protocol();
    expect(p.token({ token: 'tok-1' })).toBe('tok-1');
    expect(p.playerID({ playerId: 'p-1' })).toBe('p-1');
    expect(p.expiresAt({ expiresAt: 123 })).toBe(123);

    for (const empty of [undefined, null, {}, '', 0, false, [], new Uint8Array(0)]) {
      expect(p.token(empty)).toBe('');
      expect(p.playerID(empty)).toBe('');
      expect(p.expiresAt(empty)).toBe(0);
    }
  });

  it('推送信封：ver=1（protojson）与 ver=2（protobuf wire）都能提取原因', () => {
    const p = gatewayV1Protocol();
    const op = sessionPushOps.kickedNotify;
    const want = { reason: 'KICKED_REASON_LOGGED_IN_ELSEWHERE', ok: true };

    // ver=1：protojson 字节（枚举名下发）
    expect(
      p.kicked(op, {
        op,
        version: 1,
        body: bytesOf(JSON.stringify({ reason: 'KICKED_REASON_LOGGED_IN_ELSEWHERE' })),
      }),
    ).toEqual(want);

    // ver=2：protobuf wire 字节（枚举数值 → 枚举名）
    // 生成物 TS 枚举去掉了 KICKED_REASON_ 前缀（protobuf-es 惯例），数值仍与 proto 对齐。
    const body = newKickedBody(KickedReason.LOGGED_IN_ELSEWHERE);
    expect(p.kicked(op, { op, version: 2, body })).toEqual(want);

    // 未知 version：不抛错、识别为被挤下线但取不到原因（版本不可信则不猜编码）
    expect(p.kicked(op, { op, version: 7, body })).toEqual({ reason: '', ok: true });
  });

  it('推送识别：异常载荷安全（空/坏字节不抛错），非会话 op 返回 ok=false', () => {
    const p = gatewayV1Protocol();
    const op = sessionPushOps.kickedNotify;
    // 空载荷：识别为被挤下线但取不到原因（接缝对空载荷安全）
    expect(p.kicked(op, { op, version: 1, body: new Uint8Array(0) })).toEqual({
      reason: '',
      ok: true,
    });
    // 坏字节 / 异常载荷同样安全（类型上 body 恒为 Uint8Array，这里刻意越界传入，
    // 验证实现方的运行时防御：JS 调用方拿不到类型保护）
    expect(p.kicked(op, { op, version: 1, body: bytesOf('{') })).toEqual({ reason: '', ok: true });
    expect(p.kicked(op, { op, version: 2, body: bytesOf('{') })).toEqual({ reason: '', ok: true });
    expect(p.kicked(op, { op, version: 1, body: null as unknown as Uint8Array })).toEqual({
      reason: '',
      ok: true,
    });
    // 非会话推送 op：不识别
    expect(p.kicked('/game.v1.PlayerService/Notify', { op: '/game.v1.PlayerService/Notify', version: 1, body: new Uint8Array(0) })).toEqual({
      reason: '',
      ok: false,
    });
  });

  it('状态机零生成物依赖（S0.5）：session.ts 不 import src/gen、不含会话消息类型字面量', () => {
    const src = readFileSync(new URL('../src/client/session.ts', import.meta.url), 'utf8');
    // 会话消息类型只允许出现在接缝实现/生成 stub 内（本文件与 helpers 里的参考实现）。
    expect(src).not.toMatch(/from\s+'[^']*\/gen\//);
    expect(src).not.toMatch(/\/gateway\.v1\./);
    expect(src).not.toMatch(
      /LoginRequest|LoginReply|LogoutRequest|ResumeRequest|ResumeReply|RegisterRequest|RegisterReply|HeartbeatReply/,
    );
  });
});

describe('项目侧参考实现（examples/gatewayv1.mjs）：按推送信封 version 选解码器', () => {
  it('ver=1（protojson）与 ver=2（protobuf wire）都取到原因，未知 version 不抛错', () => {
    const proto = newGatewayV1SessionProtocol();
    const op = kickedNotifyOp;
    const want = { reason: 'KICKED_REASON_LOGGED_IN_ELSEWHERE', ok: true };

    // ver=1：protojson 字节（枚举以枚举名下发）
    const json = bytesOf(JSON.stringify({ reason: 'KICKED_REASON_LOGGED_IN_ELSEWHERE' }));
    expect(proto.kicked(op, { op, version: 1, body: json })).toEqual(want);

    // ver=2：protobuf wire 字节（枚举数值 → proto 枚举名，两种编码结果同口径）
    const wire = newKickedBody(KickedReason.LOGGED_IN_ELSEWHERE);
    expect(proto.kicked(op, { op, version: 2, body: wire })).toEqual(want);

    // 未知 version / 空载荷 / 坏字节：识别为被挤下线但取不到原因，一律不抛错
    expect(proto.kicked(op, { op, version: 7, body: wire })).toEqual({ reason: '', ok: true });
    expect(proto.kicked(op, { op, version: 2, body: new Uint8Array(0) })).toEqual({
      reason: '',
      ok: true,
    });
    expect(proto.kicked(op, { op, version: 2, body: bytesOf('{') })).toEqual({
      reason: '',
      ok: true,
    });

    // 非会话推送 op：不识别
    const other = '/game.v1.PlayerService/Notify';
    expect(proto.kicked(other, { op: other, version: 1, body: new Uint8Array(0) })).toEqual({
      reason: '',
      ok: false,
    });
  });

  it('凭据钩子与载荷编码无关：对象（ver=1）与原始字节（ver=2）都取到 token', () => {
    const proto = newGatewayV1SessionProtocol();
    expect(proto.token({ token: 'tok-obj' })).toBe('tok-obj');
    const wire = toBinary(LoginReplySchema, create(LoginReplySchema, { token: 'tok-wire' }));
    expect(proto.token(wire)).toBe('tok-wire');
    // 未知/空载荷返回空串（可选钩子语义），不抛错
    expect(proto.token(new Uint8Array(0))).toBe('');
    expect(proto.token(undefined)).toBe('');
  });
});

describe('SessionProtocol 接缝：注入 fake 即可驱动状态机', () => {
  it('登录：op 名与凭据提取全部走接缝（零真实会话 DTO）', async () => {
    const { session, close, seen } = await dialFake();
    const reply = await session.login({ playerId: 'p-1' });
    expect(reply).toEqual({});
    // 凭据来自接缝钩子（fake 返回固定值，与回执内容无关）
    expect(session.token()).toBe('fake-token');
    expect(session.playerId()).toBe('fake-player');
    expect(seen).toEqual(['/fake/Login']);
    await close();
  });

  it('会话心跳：周期心跳的 op 取自接缝', async () => {
    const { session, close, seen } = await dialFake({ heartbeatMs: 15 });
    await session.login({});
    await waitFor(() => seen.filter((op) => op === '/fake/Heartbeat').length >= 1);
    await close();
  });

  it('被踢：推送识别命中即清空凭据并记录原因', async () => {
    const { session, close, seen, servers } = await dialFake();
    await session.login({});
    expect(session.token()).toBe('fake-token');

    // 非会话推送：接缝返回 ok=false，凭据不动、原因不记
    servers[0]!.notify('/game.v1.Other/Notify', bytesOf('xx'));
    await waitFor(() => seen.length >= 1);
    expect(session.token()).toBe('fake-token');
    expect(session.kickedReason()).toBe('');

    // 被挤下线推送：接缝提取原因，状态机清空凭据
    servers[0]!.notify('/fake/Kicked', bytesOf('LOGGED_IN_ELSEWHERE'));
    await waitFor(() => session.token() === '');
    expect(session.playerId()).toBe('');
    expect(session.kickedReason()).toBe('LOGGED_IN_ELSEWHERE');
    await close();
  });

  it('被踢（ver=2）：protobuf wire 推送同样取到原因（帧头 version 随信封下发）', async () => {
    const { session, close, servers } = await dialFake({ protocol: gatewayV1Protocol() });
    const op = sessionPushOps.kickedNotify;
    const body = newKickedBody(KickedReason.SESSION_EXPIRED);
    servers[0]!.notify(op, body, 2);
    await waitFor(() => session.kickedReason() !== '');
    expect(session.kickedReason()).toBe('KICKED_REASON_SESSION_EXPIRED');
    await close();
  });
});

describe('SessionProtocol 接缝：回执解析失败即报错（不静默成功）', () => {
  it('login：回执取不到 token 抛 SessionReplyUnresolvedError（不返回「成功但 token 为空」）', async () => {
    const unresolved: SessionProtocol = { ...fakeProtocol(), token: () => '', playerID: () => '' };
    const { session, close } = await dialFake({ protocol: unresolved });
    const err = await session.login({ playerId: 'p-1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionReplyUnresolvedError);
    expect((err as SessionReplyUnresolvedError).op).toBe('/fake/Login');
    expect((err as SessionReplyUnresolvedError).field).toBe('token');
    expect(session.token()).toBe(''); // 未静默成功：凭据保持空
    await close();
  });

  it('resume：回执取不到 playerId 抛 SessionReplyUnresolvedError（token 沿用本地凭据）', async () => {
    const unresolved: SessionProtocol = { ...fakeProtocol(), playerID: () => '' };
    const { session, close } = await dialFake({ protocol: unresolved });
    await session.login({}); // 有 token，可进入 resume
    const err = await session.resume().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionReplyUnresolvedError);
    expect((err as SessionReplyUnresolvedError).field).toBe('playerId');
    await close();
  });
});

describe('SessionProtocol 接缝：订阅生命周期（绑定/重绑/关闭）', () => {
  it('重复 bind 不累积订阅、重绑先退订旧 Client、close 后不再收到推送', async () => {
    let kicks = 0;
    const counted: SessionProtocol = {
      ...fakeProtocol(),
      kicked: (op) => {
        if (op !== '/fake/Kicked') return { reason: '', ok: false };
        kicks += 1;
        return { reason: 'KICKED', ok: true };
      },
    };
    const { session, cli, servers } = await dialFake({ protocol: counted });
    // 同 Client 重复 bind：订阅表按 handler 去重，推送只处理一次
    session.bind(cli);
    servers[0]!.notify('/fake/Kicked', bytesOf('a'));
    await waitFor(() => kicks === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(kicks).toBe(1);

    // 重绑到新 Client：旧 Client 的推送必须不再进入会话（退订句柄生效）
    const other = await dialFakeClient();
    session.bind(other.cli);
    servers[0]!.notify('/fake/Kicked', bytesOf('b'));
    await new Promise((r) => setTimeout(r, 20));
    expect(kicks).toBe(1);
    other.servers[0]!.notify('/fake/Kicked', bytesOf('c'));
    await waitFor(() => kicks === 2);

    // close：退订后不再收到任何推送
    session.close();
    other.servers[0]!.notify('/fake/Kicked', bytesOf('d'));
    await new Promise((r) => setTimeout(r, 20));
    expect(kicks).toBe(2);

    await other.close();
    await cli.close();
  });
});

describe('SessionProtocol 接缝：缺失接缝即报错（不留默认 gateway.v1 副本）', () => {
  it('未接入接缝时 login/heartbeat/bind 均抛明确错误', async () => {
    const s = newSession();
    await expect(s.login({})).rejects.toThrow(/未接入会话协议/);
    await expect(s.heartbeat()).rejects.toThrow(/未接入会话协议/);
    const { dialer } = makeDialer();
    const cli = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, []);
    expect(() => s.bind(cli)).toThrow(/未接入会话协议/);
    await cli.close();
  });
});
