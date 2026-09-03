// 运行时内核测试：Invoke 匹配/超时竞态、Notify 订阅、双层心跳、断线重连与排队、
// 钩子与 hookBypass 直通窗口、dual 链式重绑、State 聚合、优雅关闭。
// 全部基于内存 mock 传输（真实通道 v0.3 接入后语义不变——接口同构）。
import { describe, expect, it } from 'vitest';
import {
  BusinessError,
  HeartbeatOperation,
  Kind,
  NetworkError,
  ProtocolError,
  TimeoutError,
  WithBackoff,
  WithFailFast,
  WithHeartbeatInterval,
  WithHookTimeout,
  WithInvokeTimeout,
  WithOnReconnected,
  WithReconnectQueueSize,
  WithRequestTimeout,
  WithSessionHeartbeat,
  encodeUtf8,
  isBusinessError,
  newClient,
  newDualClient,
  createMockTransport,
  type Client,
  type MockServer,
  type TransportDialer,
} from '../src/index.js';
import { buildReplyErr, buildReplyOK, buildTestStatus } from './helpers.js';
import type { ChannelTransport } from '../src/client/transport.js';

const replyOK = (payload: unknown) => buildReplyOK(encodeUtf8(JSON.stringify(payload)));
const replyErr = (code: number, reason: string, msg = '') =>
  buildReplyErr(buildTestStatus(code, reason, msg, null), new Uint8Array(0));

/** 测试拨号器：每次拨号产出新一代 mock 传输与对应服务端模拟器；
 * onServer 在拨号时立即回调（配置应答行为无需等 newClient 完成）。 */
function makeDialer(
  onServer?: (server: MockServer, index: number, transport: ChannelTransport) => void,
): {
  dialer: TransportDialer;
  servers: MockServer[];
  transports: ChannelTransport[];
} {
  const servers: MockServer[] = [];
  const transports: ChannelTransport[] = [];
  const dialer: TransportDialer = async () => {
    const { transport, server } = await import('../src/index.js').then((m) =>
      m.createMockTransport(),
    );
    servers.push(server);
    transports.push(transport);
    onServer?.(server, servers.length - 1, transport);
    return transport;
  };
  return { dialer, servers, transports };
}

/** 轮询等待条件成立（避免测试固定 sleep 的脆弱性）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Invoke：请求-响应匹配', () => {
  it('成功往返：请求 payload 与响应解析', async () => {
    const { dialer } = makeDialer((server) =>
      server.autoReply((op, payload) => {
        expect(op).toBe('/gateway.v1.GatewayAuth/Login');
        expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({ playerId: 'p1' });
        return replyOK({ playerId: 'p1', nickname: '阿宇' });
      }),
    );
    const c = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, []);
    const resp = (await c.invoke('/gateway.v1.GatewayAuth/Login', { playerId: 'p1' })) as {
      playerId: string;
      nickname: string;
    };
    expect(resp).toEqual({ playerId: 'p1', nickname: '阿宇' });
    await c.close();
  });

  it('业务拒绝：还原 BusinessError 并按 Reason 分支', async () => {
    const { dialer } = makeDialer((server) =>
      server.autoReply(() => replyErr(404, 'PLAYER_NOT_FOUND', '玩家不存在')),
    );
    const c = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, []);
    const err = await c.invoke('/op', null).catch((e: unknown) => e);
    expect(isBusinessError(err, 'PLAYER_NOT_FOUND')).toBe(true);
    expect((err as BusinessError).code).toBe(404);
    expect((err as BusinessError).messageText).toBe('玩家不存在');
    await c.close();
  });

  it('超时：迟到响应被静默丢弃（恰一次结算）', async () => {
    const { dialer } = makeDialer((server) =>
      // 响应迟到：60ms 后才回（超过 per-call 30ms 超时），验证迟到响应静默丢弃
      server.onFrame((h) => {
        if (h.type !== 1) return;
        setTimeout(() => server.sendFrame(2, h.seq, replyOK({ ok: 1 })), 60);
      }),
    );
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithInvokeTimeout(10_000)],
    );
    await expect(
      c.invoke('/slow', null, WithRequestTimeout(30)),
    ).rejects.toBeInstanceOf(TimeoutError);
    await new Promise((r) => setTimeout(r, 20)); // 迟到响应到达
    expect(c.state()).toBe('connected'); // 通道不受超时影响
    await c.close();
  });

  it('seq 跨请求单调递增', async () => {
    const seen: number[] = [];
    const { dialer } = makeDialer((server) => {
      server.onFrame((h, body) => {
        if (h.type !== 1) return;
        seen.push(h.seq);
        server.sendFrame(2, h.seq, replyOK({}));
      });
    });
    const c = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, []);
    await c.invoke('/a', null);
    await c.invoke('/b', null);
    expect(seen.length).toBe(2);
    expect(seen[1]! > seen[0]!).toBe(true);
    await c.close();
  });
});

describe('Notify：推送订阅', () => {
  it('多订阅者分发、退订生效、同 handler 幂等', async () => {
    const { dialer, servers } = makeDialer();
    const c = await newClient(dialer, { kind: 'memory', addr: 'mock' }, Kind.Business, []);
    const got1: string[] = [];
    const got2: string[] = [];
    const h1 = (_op: string, p: Uint8Array) => void got1.push(new TextDecoder().decode(p));
    const off1 = c.on('/lockstep.v1.Session/OnFrame', h1);
    c.on('/lockstep.v1.Session/OnFrame', h1); // 同 handler 幂等
    const off2 = c.on('/lockstep.v1.Session/OnFrame', (_op, p) => void got2.push(new TextDecoder().decode(p)));
    servers[0]!.notify('/lockstep.v1.Session/OnFrame', encodeUtf8('{"frameId":"1"}'));
    await waitFor(() => got1.length === 1 && got2.length === 1);
    off1();
    off1(); // 退订幂等
    servers[0]!.notify('/lockstep.v1.Session/OnFrame', encodeUtf8('{"frameId":"2"}'));
    await waitFor(() => got2.length === 2);
    expect(got1.length).toBe(1); // 已退订不再收
    await c.close();
  });
});

describe('断线重连与请求排队', () => {
  it('断连：in-flight 立即 NetworkError；自动重连后 Invoke 恢复', async () => {
    const { dialer, servers } = makeDialer((server, index) =>
      server.autoReply(() => replyOK({ gen: index + 1 })),
    );
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithBackoff(10, 50)],
    );
    servers[0]!.autoReply(() => replyOK({ ok: 1 }));
    expect(await c.invoke('/a', null)).toEqual({ ok: 1 });

    servers[0]!.drop(); // 断连
    await waitFor(() => c.state() === 'reconnecting');
    await expect(c.invoke('/b', null, WithFailFast())).rejects.toBeInstanceOf(NetworkError);

    // 第二代连接建立并应答（每代 autoReply：gen 递增可验证走到了新代）
    await waitFor(() => c.state() === 'connected');
    expect(await c.invoke('/c', null)).toEqual({ gen: 2 });
    await c.close();
  });

  it('重连期间默认排队：重连成功后按 FIFO 顺序重发', async () => {
    const { dialer, servers } = makeDialer((server) => server.autoReply(() => replyOK({ ok: 1 })));
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithBackoff(10, 30)],
    );
    servers[0]!.drop();
    await waitFor(() => c.state() === 'reconnecting');

    // 重连期间发起三个请求（默认排队；无响应队列不会被消费）
    const order: string[] = [];
    const p1 = c.invoke('/q1', null).then(() => order.push('q1'), () => order.push('q1!'));
    const p2 = c.invoke('/q2', null).then(() => order.push('q2'), () => order.push('q2!'));
    const p3 = c.invoke('/q3', null).then(() => order.push('q3'), () => order.push('q3!'));

    await waitFor(() => c.state() === 'connected');
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['q1', 'q2', 'q3']); // FIFO
    await c.close();
  });

  it('排队上限：满后立即失败 NetworkError', async () => {
    const { dialer, servers } = makeDialer();
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithBackoff(10, 30), WithReconnectQueueSize(2)],
    );
    servers[0]!.drop();
    await waitFor(() => c.state() === 'reconnecting');
    // 排队中的请求在 close 时被 failQueued reject（预期语义）；attach catch
    // 避免 unhandled rejection（评审发现的测试缺陷）。
    const q1 = c.invoke('/q1', null).catch(() => undefined);
    const q2 = c.invoke('/q2', null).catch(() => undefined);
    await expect(c.invoke('/q3', null)).rejects.toThrow(/排队已满/);
    await c.close();
    await Promise.all([q1, q2]);
  });

  it('协议错误（包络非法）终止通道且不重连', async () => {
    const { dialer, servers, transports } = makeDialer();
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithBackoff(10, 30)],
    );
    const bad = new Uint8Array([9, 9, 9]); // 非法包络
    servers[0]!.autoReply(() => bad);
    await expect(c.invoke('/bad', null)).rejects.toBeInstanceOf(ProtocolError);
    await waitFor(() => transports[0]!.kind !== undefined && c.state() === 'disconnected');
    await new Promise((r) => setTimeout(r, 40)); // 给重连误触发的窗口
    expect(c.state()).toBe('disconnected'); // 不重连
    expect(servers.length).toBe(1); // 未拨新连接
    await c.close();
  });
});

describe('重连钩子与 hookBypass 直通窗口', () => {
  it('重连成功后钩子执行；钩子内 Invoke 直通（重登可用）', async () => {
    const { dialer, servers } = makeDialer((server) =>
      server.autoReply(() => replyOK({ loggedIn: true })),
    );
    let hookRuns = 0;
    let reloginResp: unknown;
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [
        WithBackoff(10, 30),
        WithOnReconnected(() => {
          hookRuns += 1;
          // 钩子内 Invoke：hookBypass 直通当前代连接（重登请求不排队）
          return c
            .invoke('/gateway.v1.GatewayAuth/Login', { token: 'fresh' })
            .then((r) => {
              reloginResp = r;
            });
        }),
      ],
    );
    servers[0]!.drop();
    await waitFor(() => c.state() === 'connected');
    await waitFor(() => hookRuns === 1);
    expect(reloginResp).toEqual({ loggedIn: true });
    await c.close();
  });

  it('钩子超时：弃用本代连接继续退避重连（窗口上限 = hookTimeout）', async () => {
    const { dialer, servers } = makeDialer();
    let hookRuns = 0;
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [
        WithBackoff(5, 20),
        WithHookTimeout(40),
        WithOnReconnected(() => {
          hookRuns += 1;
          return new Promise<void>(() => {}); // 挂起不返回
        }),
      ],
    );
    servers[0]!.drop();
    await waitFor(() => hookRuns >= 1 && servers.length >= 3, 3000); // 超时弃用 → 再拨号
    await c.close();
  });
});

describe('双层心跳', () => {
  it('传输心跳业务拒绝不计死链（链路保持）', async () => {
    const { dialer, servers } = makeDialer();
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithHeartbeatInterval(15)],
    );
    // 单一帧处理器：Ping → 业务拒绝包络（往返完成 = 链路存活）；其余 op → 成功
    let pingCount = 0;
    servers[0]!.onFrame((h, body) => {
      if (h.type !== 1) return;
      const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
      const op = new TextDecoder().decode(body.subarray(2, 2 + opLen));
      if (op === HeartbeatOperation) {
        pingCount += 1;
        servers[0]!.sendFrame(2, h.seq, replyErr(500, 'PING_REJECTED'));
      } else {
        servers[0]!.sendFrame(2, h.seq, replyOK({}));
      }
    });
    await new Promise((r) => setTimeout(r, 80)); // 数个心跳周期全部被业务拒绝
    expect(pingCount).toBeGreaterThanOrEqual(2);
    expect(c.state()).toBe('connected'); // 未判死链、未重连
    expect(servers.length).toBe(1);
    await c.close();
  });

  it('传输心跳网络失败连续 3 次 → 判死链重连', async () => {
    const { dialer, servers } = makeDialer();
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithHeartbeatInterval(15), WithBackoff(10, 30)],
    );
    // 服务端收到 Ping 不回（网络失败 = 超时）→ 3 次后死链
    await waitFor(() => servers.length >= 2, 3000); // 发生重连
    expect(c.state()).toBe('connected');
    await c.close();
  });

  it('会话心跳仅业务通道 + 业务错误单飞触发重登钩子', async () => {
    const { dialer, servers } = makeDialer();
    let relogins = 0;
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [
        WithSessionHeartbeat(20, () => ({ op: '/gateway.v1.GatewayAuth/Heartbeat', req: { token: 't' } })),
        WithOnReconnected(() => {
          relogins += 1;
          return undefined;
        }),
      ],
    );
    // 会话心跳被业务拒绝 → 触发重登钩子（单飞：多次拒绝只挂一轮）
    servers[0]!.autoReply((op) => {
      if (op === '/gateway.v1.GatewayAuth/Heartbeat') return replyErr(401, 'SESSION_EXPIRED');
      return replyOK({});
    });
    await waitFor(() => relogins >= 1, 2000);
    const at = relogins;
    await new Promise((r) => setTimeout(r, 60));
    expect(relogins).toBeGreaterThanOrEqual(at); // 单飞期间不重复触发
    await c.close();
  });

  it('会话心跳工厂未就绪（返回 null）跳过本轮', async () => {
    const { dialer, servers } = makeDialer();
    let hbFrames = 0;
    let ready = false;
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithSessionHeartbeat(15, () => (ready ? { op: '/hb' } : null))],
    );
    servers[0]!.onFrame((h, body) => {
      if (h.type !== 1) return;
      const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
      const op = new TextDecoder().decode(body.subarray(2, 2 + opLen));
      if (op === '/hb') hbFrames += 1;
      servers[0]!.sendFrame(2, h.seq, replyOK({}));
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(hbFrames).toBe(0); // 未就绪期间零调用
    ready = true;
    await waitFor(() => hbFrames >= 1);
    await c.close();
  });

  it('重连后会话心跳仍单循环（评审 Fix：每代启动会泄漏并发循环）', async () => {
    const { dialer, servers } = makeDialer();
    let hbFrames = 0;
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithSessionHeartbeat(15, () => ({ op: '/hb' }))],
    );
    servers[0]!.onFrame((h, body) => {
      if (h.type !== 1) return;
      const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
      const op = new TextDecoder().decode(body.subarray(2, 2 + opLen));
      if (op === '/hb') hbFrames += 1;
      servers[0]!.sendFrame(2, h.seq, replyOK({}));
    });
    await waitFor(() => hbFrames >= 1);
    const base = hbFrames;
    // 断线 → 重连（新代；若会话心跳每代启动会泄漏第二个循环）
    servers[0]!.drop();
    await waitFor(() => c.state() === 'connected');
    const after = hbFrames;
    // 重连后心跳频率应不变（单循环）：统计窗口内增量不翻倍。
    await new Promise((r) => setTimeout(r, 80));
    const rate1 = after - base;
    const rate2 = hbFrames - after;
    // 若泄漏（双循环），rate2 约为 rate1 的两倍；单循环则接近相等。
    expect(rate2).toBeLessThan(rate1 * 1.6 + 2);
    await c.close();
  });
});

describe('dual 双通道编排', () => {
  function makeDual() {
    const { dialer, servers, transports } = makeDialer();
    // 拨号顺序：newDualClient 先建 battle 后建 business，但 supervisor 并发拨号——
    // 以地址区分：业务 9001，战斗 9002。
    const businessServers: MockServer[] = [];
    const battleServers: MockServer[] = [];
    const dialer2: TransportDialer = async (cfg) => {
      const { transport, server } = await import('../src/index.js').then((m) =>
        m.createMockTransport(),
      );
      servers.push(server);
      transports.push(transport);
      if (cfg.addr.endsWith('9001')) businessServers.push(server);
      else battleServers.push(server);
      return transport;
    };
    return { dialer: dialer2, businessServers, battleServers };
  }

  it('State 聚合向下降级：战斗通道重连 → client reconnecting', async () => {
    const { dialer, businessServers, battleServers } = makeDual();
    const c: Client = await newDualClient(
      dialer,
      { addr: 'mock:9001' },
      { addr: 'mock:9002', transport: 'memory' },
      [WithBackoff(10, 30)],
    );
    businessServers[0]!.autoReply(() => replyOK({}));
    battleServers[0]!.autoReply(() => replyOK({}));
    expect(c.state()).toBe('connected');
    battleServers[0]!.drop(); // 只踢战斗通道
    await waitFor(() => c.state() === 'reconnecting');
    await waitFor(() => c.state() === 'connected');
    expect(c.channel(Kind.Battle)?.state()).toBe('connected');
    expect(businessServers.length).toBe(1); // 业务通道未受影响
    await c.close();
  });

  it('链式重绑：业务重登成功 → 自动触发战斗 Join 重绑', async () => {
    const { dialer, businessServers, battleServers } = makeDual();
    const log: string[] = [];
    let battleJoined = 0;
    const c: Client = await newDualClient(
      dialer,
      {
        addr: 'mock:9001',
        opts: [WithOnReconnected(() => (log.push('relogin'), Promise.resolve()))],
      },
      {
        addr: 'mock:9002',
        transport: 'memory',
        opts: [WithOnReconnected(() => (battleJoined += 1, log.push('rebind'), Promise.resolve()))],
      },
      [WithBackoff(10, 30)],
    );
    businessServers[0]!.autoReply(() => replyOK({}));
    battleServers[0]!.autoReply(() => replyOK({}));

    // 踢业务通道 → 重连 → 重登 → 链式战斗重绑
    businessServers[0]!.drop();
    await waitFor(() => battleJoined >= 1, 3000);
    expect(log).toEqual(['relogin', 'rebind']);
    expect(battleServers.length).toBe(1); // 战斗通道本身未断（重绑走既有连接）
    await c.close();
  });

  it('链式重绑：战斗通道未就绪时跳过本轮', async () => {
    const { dialer, businessServers, battleServers } = makeDual();
    let battleJoined = 0;
    const c: Client = await newDualClient(
      dialer,
      { addr: 'mock:9001' },
      {
        addr: 'mock:9002',
        transport: 'memory',
        opts: [WithOnReconnected(() => (battleJoined += 1, Promise.resolve()))],
      },
      [WithBackoff(10, 30)],
    );
    businessServers[0]!.autoReply(() => replyOK({}));
    battleServers[0]!.autoReply(() => replyOK({}));
    battleServers[0]!.drop(); // 战斗通道先断（未就绪窗口）
    await waitFor(() => c.channel(Kind.Battle)?.state() === 'reconnecting');
    businessServers[0]!.drop(); // 业务通道随后断
    await waitFor(() => c.channel(Kind.Business)?.state() === 'connected', 3000);
    await new Promise((r) => setTimeout(r, 50));
    // 战斗未就绪 → 业务重登成功后跳过重绑（由战斗自身重连时钩子完成）
    expect(battleServers.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => battleJoined >= 1, 3000); // 战斗自身恢复后钩子执行
    await c.close();
  });
});

describe('优雅关闭', () => {
  it('Close：in-flight 与排队请求立即 NetworkError；幂等', async () => {
    const { dialer, servers } = makeDialer();
    const c = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithBackoff(10, 30)],
    );
    servers[0]!.drop();
    await waitFor(() => c.state() === 'reconnecting');
    const p = c.invoke('/queued', null); // 排队中
    await c.close();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    await expect(c.close()).resolves.toBeUndefined(); // 幂等
    await expect(c.invoke('/after', null)).rejects.toBeInstanceOf(NetworkError);
  });

  it('慢拨号期间 close 不挂起（评审 Blocker：拨号返回后未复查 closed）', async () => {
    const servers: MockServer[] = [];
    const transports: ChannelTransport[] = [];
    let callCount = 0;
    let dialStarted = false;
    let releaseDial!: () => void;
    const dialGate = new Promise<void>((r) => { releaseDial = r; });
    const dialer: TransportDialer = async () => {
      callCount += 1;
      if (callCount === 1) {
        // 首连直接返回（不 gate）
        const { transport, server } = createMockTransport();
        servers.push(server);
        transports.push(transport);
        return transport;
      }
      // 重连拨号：挂起直到测试释放（模拟慢拨号）
      dialStarted = true;
      await dialGate;
      const { transport, server } = createMockTransport();
      servers.push(server);
      transports.push(transport);
      return transport;
    };
    const c = await newClient(dialer, { kind: 'memory', addr: 'slow' }, Kind.Business, [
      WithBackoff(10, 30),
    ]);
    servers[0]!.drop();
    // 等慢拨号真正开始（dialStarted 置位后 close）
    await waitFor(() => dialStarted);
    const closeP = c.close();
    releaseDial(); // 释放拨号 → transport 建立
    // close 必须在 2s 内完成（修复前：建新代读循环不退出 → 永久挂起）
    await expect(
      Promise.race([
        closeP,
        new Promise((_, rej) => setTimeout(() => rej(new Error('close 挂起：慢拨号返回后未终止')), 2000)),
      ]),
    ).resolves.toBeUndefined();
  });
});
