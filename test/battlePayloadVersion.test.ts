// 战斗直连的载荷编码版本（ver）透传与放行：与 Go SDK 的 direct 包同形——
// SDK 只交 `(payload, version)`，游戏消息由调用方按版本用协议包解码。
//
// 本文件钉四件事：
//   1. 推送分发带版本：onFrame / onPush / onBattleEnd 拿到**逐字节原始载荷 + 帧头版本**，
//      SDK 不做任何预解（ver=2 的二进制按 protojson 解必然失败）；
//   2. 帧号钩子：**所有版本**都只认注入的钩子（内建 protojson 解析已随游戏域消息删除），
//      未注入或钩子返回 null ⇒ 不推进补帧基准、也不报错；
//   3. 放行 ver=2：出站版本由序列化器推导（缺省 ver=1），回执版本只接受白名单 {1,2} 且必须
//      与会话一致，未知版本（如 3）是明确的协议级错误；
//   4. 缺省用法不变：缺省会话发 ver=1，一参 onFrame 回调可用，noteFrame 手动推进照旧。
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { MockBattleServer, jsonBytes, makeBattleFactory } from './battleMock.js';
import {
  STUB_OP_END,
  STUB_OP_FRAME,
  STUB_OP_JOIN,
  STUB_OP_INPUT,
  battleDefaults,
  jsonFrameNumberOf,
  sendFrameInput,
  syncFrames,
} from './battleStub.js';
import {
  MAGIC,
  MsgType,
  ProtocolError,
  VERSION,
  VERSION_2,
  openBattleSession,
  parseDirectPlan,
  type BattleSession,
  type BattleSessionOptions,
  type Serializer,
  type WebSocketFactory,
} from '../src/index.js';
import { JsonSerializer } from '../src/client/serializer.js';
import { BattleInbound, type InboundHooks } from '../src/battle/inbound.js';

/** Ver2JsonSerializer 声明 ver=2 的序列化器（帧头版本协商用测试夹具）：
 * 载荷仍是 JSON 字节（真实 ver=2 编码归游戏侧协议包），本文件只验版本透传与放行。 */
class Ver2JsonSerializer extends JsonSerializer {
  readonly version = VERSION_2;
}

/** TICKET 参考票密文（与 battleSession.test.ts 同一向量）。 */
const TICKET = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);

/** planOf 构造一份只开 WS 面的上线包。 */
function planOf(): ReturnType<typeof parseDirectPlan> {
  return parseDirectPlan({
    matchId: 'm-7',
    battleId: 'b-9',
    battleTicket: Buffer.from(TICKET).toString('base64'),
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: '10.0.0.9:7100' }],
  });
}

/** joinOKv 服务端按指定载荷编码版本回执（缺省 ver=1）：帧面按请求版本回显。 */
function joinOKv(srv: MockBattleServer, version = VERSION): void {
  srv.onRequest((req, s) => {
    if (req.op === STUB_OP_JOIN) s.replyOK(jsonBytes({ currentFrame: '3' }), version);
    else s.replyOK(new Uint8Array(0), version);
  });
}

/** open 打开一条直连会话（各用例统一入口）：探针/重放/帧号钩子由测试侧替身给出。 */
function open(factory: WebSocketFactory, opts: BattleSessionOptions = {}): Promise<BattleSession> {
  return openBattleSession(planOf(), { ...battleDefaults('b-9'), wsFactory: factory, ...opts });
}

describe('帧号钩子与载荷编码版本（ver）透传', () => {
  it('ver=1 帧号走注入钩子：内建 protojson 解析已随游戏域消息删除（钩子拿到原始载荷）', async () => {
    const observed: Uint8Array[] = [];
    const h = makeBattleFactory((srv) => joinOKv(srv));
    const s = await open(h.factory, {
      frameNumberOf: (payload) => {
        observed.push(payload);
        return 7;
      },
    });
    h.servers[0]!.notify(STUB_OP_FRAME, jsonBytes({ battleId: 'b-9', frame: { frameId: '3' } }));
    await waitFor(() => s.lastSeenFrame() === 7);
    expect(observed.length).toBe(1); // ver=1 不再是「恒走内建、注入也不接管」
    expect(Array.from(observed[0]!)).toEqual(Array.from(jsonBytes({ battleId: 'b-9', frame: { frameId: '3' } })));
    await s.close();
  });

  it('ver=2 帧广播：注入钩子后补帧基准按钩子推进（钩子拿到逐字节载荷与帧头版本）', async () => {
    const observed: Array<{ payload: Uint8Array; version: number }> = [];
    const h = makeBattleFactory((srv) => joinOKv(srv, VERSION_2));
    const s = await open(h.factory, {
      serializer: new Ver2JsonSerializer(),
      frameNumberOf: (payload, version) => {
        observed.push({ payload, version });
        return payload[1] ?? null; // 约定载荷 = [0x08, 帧号]（手写二进制，非 JSON）
      },
    });
    h.servers[0]!.notify(STUB_OP_FRAME, Uint8Array.from([0x08, 9]), VERSION_2);
    await waitFor(() => s.lastSeenFrame() === 9);
    expect(observed[0]?.version).toBe(VERSION_2);
    expect(Array.from(observed[0]!.payload)).toEqual([0x08, 9]);
    await s.close();
  });

  it('钩子返回 null（取不到帧号）→ 不推进补帧基准、不报错、会话照常可用', async () => {
    let framed = 0;
    const h = makeBattleFactory((srv) => joinOKv(srv, VERSION_2));
    const s = await open(h.factory, {
      serializer: new Ver2JsonSerializer(),
      frameNumberOf: () => null,
      onFrame: () => void (framed += 1),
    });
    h.servers[0]!.notify(STUB_OP_FRAME, Uint8Array.from([0x08, 9]), VERSION_2);
    await waitFor(() => framed === 1);
    expect(s.lastSeenFrame()).toBe(0); // 取不到帧号：不推进（也不猜编码）
    expect(s.state()).toBe('connected'); // 取不到帧号不得影响会话
    await expect(syncFrames(s, 'b-9', 0)).resolves.toBeDefined();
    await s.close();
  });

  it('未注入帧号钩子：ver=1 与 ver=2 都不推进（不猜编码），onFrame 照常回调', async () => {
    const versions: number[] = [];
    const h = makeBattleFactory((srv) => joinOKv(srv));
    const s = await open(h.factory, {
      frameNumberOf: undefined,
      onFrame: (_payload, version) => void versions.push(version),
    });
    h.servers[0]!.notify(STUB_OP_FRAME, Uint8Array.from([0x08, 9]), VERSION_2);
    h.servers[0]!.notify(STUB_OP_FRAME, jsonBytes({ frame: { frameId: '3' } }), VERSION);
    await waitFor(() => versions.length === 2);
    expect(s.lastSeenFrame()).toBe(0); // 两种编码都不推进：帧号属游戏协议，SDK 不持类型
    expect(s.state()).toBe('connected');
    await s.close();
  });
});

describe('响应帧载荷编码版本（ver）白名单', () => {
  it('收帧面：响应帧版本不在白名单（3）→ 明确协议错误（含版本与白名单 {1,2}）', async () => {
    const hooks: InboundHooks = {
      version: VERSION,
      maxBodySize: 4096,
      settle: () => {},
      takeHeartbeat: () => false,
      onHeartbeatRejected: () => {},
      onTerminalReject: () => {},
      absorbEnd: () => false,
    };
    const inbound = new BattleInbound(hooks);
    // 直接交一条 ver=3 的响应帧头：真实 WS 面会在帧层先拒（见下一个用例），
    // 此处验证会话自身的白名单兜底（对齐 Go 用 fakeConn 驱动 dispatchResponse 的用例）。
    const fatal = await inbound.readFrames({
      kind: 'memory',
      readFrame: async () => ({
        header: { magic: MAGIC, version: 3, type: MsgType.Response, flags: 0, seq: 7, length: 0 },
        body: new Uint8Array(0),
      }),
      writeFrame: async () => {},
      close: async () => {},
    });
    expect(fatal).toBeInstanceOf(ProtocolError);
    expect((fatal as ProtocolError).message).toContain('白名单');
    expect((fatal as ProtocolError).message).toContain('3');
  });

  it('真传输：服务端回未知版本（3）→ 会话失败，错误文本指明非法版本（不静默吞因）', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        // 入局回 ver=1；发帧回未知的 ver=3（模拟对端不按协商版本回显）
        s.replyOK(jsonBytes({ currentFrame: '3' }), req.op === STUB_OP_INPUT ? 3 : VERSION);
      });
    });
    const s = await open(h.factory);
    const err = await sendFrameInput(s, 'b-9', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    // 帧层在会话之前先拒未知版本：原因文本必须透传到对外错误（不许只报「帧协议非法」）
    expect((err as ProtocolError).message).toContain('invalid version: 3');
    await s.close();
  });
});

describe('ver=2 放行与缺省用法不变', () => {
  it('ver=2 帧广播 / 结束通知：回调拿到 version=2 与逐字节原始载荷（SDK 不预解）', async () => {
    const frames: Array<{ payload: Uint8Array; version: number }> = [];
    const pushes: Array<{ op: string; payload: Uint8Array; version: number }> = [];
    const ends: Array<{ payload: Uint8Array; version: number }> = [];
    const h = makeBattleFactory((srv) => joinOKv(srv, VERSION_2));
    const s = await open(h.factory, {
      serializer: new Ver2JsonSerializer(),
      onFrame: (payload, version) => void frames.push({ payload, version }),
      onPush: (op, payload, version) => void pushes.push({ op, payload, version }),
      onBattleEnd: (payload, version) => void ends.push({ payload, version }),
    });
    const broadcast = Uint8Array.from([0x08, 0x09]); // 手写二进制（不是合法 JSON）
    const end = Uint8Array.from([0x0a, 0x01, 0x31]);
    h.servers[0]!.notify(STUB_OP_FRAME, broadcast, VERSION_2);
    h.servers[0]!.notify(STUB_OP_END, end, VERSION_2);
    await waitFor(() => ends.length === 1);
    expect(frames[0]?.version).toBe(VERSION_2);
    expect(Array.from(frames[0]!.payload)).toEqual([0x08, 0x09]);
    expect(ends[0]?.version).toBe(VERSION_2);
    expect(Array.from(ends[0]!.payload)).toEqual([0x0a, 0x01, 0x31]);
    expect(pushes.some((p) => p.op === STUB_OP_FRAME && p.version === VERSION_2)).toBe(true);
    expect(s.lastSeenFrame()).toBe(0); // 默认钩子解不了二进制：不推进（专门用例见上）
    await s.close();
  });

  it('ver=2 请求 / 回执放行：请求帧头 version=2，ver=2 回执被接受', async () => {
    const h = makeBattleFactory((srv) => joinOKv(srv, VERSION_2));
    const s = await open(h.factory, { serializer: new Ver2JsonSerializer() });
    await s.invoke(STUB_OP_JOIN, { battleId: 'b-9' });
    // 出站版本由序列化器推导（缺省 ver=1 不变，见下一个用例）
    expect(h.servers[0]!.frames[0]!.header.version).toBe(VERSION_2);
    await expect(sendFrameInput(s, 'b-9', 1)).resolves.toBeDefined();
    await s.close();
  });

  it('白名单内的版本失配（ver=1 会话收到 ver=2 回执）→ 明确协议错误', async () => {
    const h = makeBattleFactory((srv) => {
      srv.onRequest((req, s) => {
        s.replyOK(jsonBytes({ currentFrame: '3' }), req.op === STUB_OP_INPUT ? VERSION_2 : VERSION);
      });
    });
    const s = await open(h.factory);
    const err = await sendFrameInput(s, 'b-9', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toContain('不一致');
    await s.close();
  });

  it('缺省用法不变：缺省会话帧头 ver=1、一参 onFrame 回调可用、noteFrame 手动推进', async () => {
    const seen: Uint8Array[] = [];
    const h = makeBattleFactory((srv) => joinOKv(srv));
    const s = await open(h.factory, { frameNumberOf: undefined, onFrame: (payload) => void seen.push(payload) });
    await s.invoke(STUB_OP_JOIN, { battleId: 'b-9' });
    expect(h.servers[0]!.frames[0]!.header.version).toBe(VERSION); // 缺省 ver=1（调试开关）
    h.servers[0]!.notify(STUB_OP_FRAME, jsonBytes({ frame: { frameId: '5' } }), VERSION);
    await waitFor(() => seen.length === 1);
    expect(s.lastSeenFrame()).toBe(0); // 未注入钩子：不内建解析
    s.noteFrame(6); // 调用方自解载荷时手动推进（只前进不后退）
    expect(s.lastSeenFrame()).toBe(6);
    expect(jsonFrameNumberOf(jsonBytes({ frame: { frameId: '5' } }))).toBe(5); // 生产侧钩子等价形态
    await s.close();
  });

  it('建连前校验出站版本：序列化器声明 3（白名单外）→ 明确报错且**不拨号**', async () => {
    const h = makeBattleFactory((srv) => joinOKv(srv));
    const bad = {
      name: 'bad-version',
      version: 3,
      marshal: (): Uint8Array => new Uint8Array(0),
      unmarshal: (payload: Uint8Array): Uint8Array => payload,
    } as unknown as Serializer;
    const err = await open(h.factory, { serializer: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).message).toContain('白名单'); // 文本指明白名单，不「猜编码」
    expect(h.urls.length).toBe(0); // 高代价的非法版本在拨号前就被拒
  });
});
