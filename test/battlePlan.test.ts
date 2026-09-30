// 战斗直连上线包（plan）解析与票据槽/升级 URL 编码测试。
// 覆盖规格 §7：面按**枚举名**取（TS 只有 WS）、票为 protojson **标准 base64（带填充）**、
// 缺 WS 面即明确报错（不得猜端口/换面）；帧会话槽与升级 query 共用
// **base64url（RawURLEncoding，无填充）**的票密文取值。
import { describe, expect, it } from 'vitest';
import { ProtocolError as FrameProtocolError } from '../src/frame/index.js';
import {
  EdgeTransport,
  ProtocolError,
  buildWsUrl,
  encodeBase64UrlRaw,
  decodeBase64Std,
  isMatchStartedNotifyOp,
  parseDirectPlan,
  ticketSlotValue,
} from '../src/index.js';

/** 参考票据密文（5 字节，含非 ASCII 字节，能暴露 base64 变体错误）。 */
const TICKET_BYTES = Uint8Array.from([1, 2, 3, 0xfb, 0xff]);
/** 参考值由 Node Buffer 独立给出（不与被测实现同源计算）：
 * 标准 base64 = AQID+/8=、base64url raw = AQID-_8。 */
const TICKET_STD_B64 = 'AQID+/8=';
const TICKET_URL_B64 = 'AQID-_8';

/** 一份完整成局通知 payload（protojson 形态，enum 名下发）。 */
function notifyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    matchId: 'm-7',
    battleId: 'b-9',
    playerIds: ['p-1', 'p-2'],
    battleTicket: TICKET_STD_B64,
    endpoints: [
      { transport: 'EDGE_TRANSPORT_WS', address: '10.0.0.9:7100' },
      { transport: 'EDGE_TRANSPORT_KCP', address: '10.0.0.9:7101' },
      { transport: 'EDGE_TRANSPORT_UDP', address: '10.0.0.9:7102' },
    ],
    ...overrides,
  };
}

describe('parseDirectPlan 成局通知解析', () => {
  it('枚举名 → 传输面，票按标准 base64 解码为字节', () => {
    const plan = parseDirectPlan(notifyPayload());
    expect(plan.matchId).toBe('m-7');
    expect(plan.battleId).toBe('b-9');
    expect(plan.ticket).toEqual(TICKET_BYTES);
    expect(plan.endpoints.size).toBe(3);
    expect(plan.endpoints.get(EdgeTransport.Ws)).toBe('10.0.0.9:7100');
    expect(plan.endpoints.get(EdgeTransport.Kcp)).toBe('10.0.0.9:7101');
    expect(plan.endpoints.get(EdgeTransport.Udp)).toBe('10.0.0.9:7102');
  });

  it('接受原始 protojson 字节与推送信封 JSON（{type,payload}）两种形态', () => {
    const raw = new TextEncoder().encode(JSON.stringify(notifyPayload()));
    expect(parseDirectPlan(raw).battleId).toBe('b-9');
    const envelope = JSON.stringify({ type: '/game.v1.MatchStartedNotify', payload: notifyPayload() });
    const plan = parseDirectPlan(envelope);
    expect(plan.battleId).toBe('b-9');
    expect(plan.ticket).toEqual(TICKET_BYTES);
  });

  it('只开 WS 一面也能解析（不要求三面齐全）', () => {
    const plan = parseDirectPlan(notifyPayload({
      endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: 'edge.example:7100' }],
    }));
    expect(plan.endpoints.size).toBe(1);
    expect(plan.endpoints.get(EdgeTransport.Ws)).toBe('edge.example:7100');
  });

  it('缺 WS 面 → ProtocolError（明确报错，不猜端口、不换面）', () => {
    const payload = notifyPayload({
      endpoints: [
        { transport: 'EDGE_TRANSPORT_KCP', address: '10.0.0.9:7101' },
        { transport: 'EDGE_TRANSPORT_UDP', address: '10.0.0.9:7102' },
      ],
    });
    expect(() => parseDirectPlan(payload)).toThrow(ProtocolError);
    expect(() => parseDirectPlan(payload)).toThrow(/EDGE_TRANSPORT_WS/);
  });

  it('endpoints 缺失或为空 → ProtocolError', () => {
    expect(() => parseDirectPlan(notifyPayload({ endpoints: [] }))).toThrow(ProtocolError);
    expect(() => parseDirectPlan(notifyPayload({ endpoints: undefined }))).toThrow(ProtocolError);
  });

  it('缺票 / 空票 → ProtocolError', () => {
    expect(() => parseDirectPlan(notifyPayload({ battleTicket: undefined }))).toThrow(ProtocolError);
    expect(() => parseDirectPlan(notifyPayload({ battleTicket: '' }))).toThrow(ProtocolError);
  });

  it('票不是合法标准 base64 → ProtocolError', () => {
    expect(() => parseDirectPlan(notifyPayload({ battleTicket: '!!!not-base64!!!' }))).toThrow(ProtocolError);
  });

  it('缺 battle_id → ProtocolError；缺 match_id 不报错（仅信息字段）', () => {
    expect(() => parseDirectPlan(notifyPayload({ battleId: '' }))).toThrow(ProtocolError);
    expect(parseDirectPlan(notifyPayload({ matchId: undefined })).matchId).toBe('');
  });

  it('未知传输面名忽略（不猜面）、地址为空的条目忽略', () => {
    const plan = parseDirectPlan(notifyPayload({
      endpoints: [
        { transport: 'EDGE_TRANSPORT_QUIC', address: '10.0.0.9:7103' },
        { transport: 'EDGE_TRANSPORT_WS', address: '' },
        { transport: 'EDGE_TRANSPORT_WS', address: '10.0.0.9:7100' },
      ],
    }));
    expect(plan.endpoints.size).toBe(1);
    expect(plan.endpoints.get(EdgeTransport.Ws)).toBe('10.0.0.9:7100');
  });

  it('payload 不是 JSON 对象 → ProtocolError', () => {
    expect(() => parseDirectPlan('{oops')).toThrow(ProtocolError);
    expect(() => parseDirectPlan('[]')).toThrow(ProtocolError);
  });

  it('isMatchStartedNotifyOp 同时接受消息完整名与服务限定名', () => {
    expect(isMatchStartedNotifyOp('/game.v1.MatchStartedNotify')).toBe(true);
    expect(isMatchStartedNotifyOp('/game.v1.PlayerService/MatchStartedNotify')).toBe(true);
    expect(isMatchStartedNotifyOp('/game.v1.MatchFailedNotify')).toBe(false);
  });
});

describe('票据槽与升级 URL 编码', () => {
  it('ticketSlotValue = base64url（RawURLEncoding，无填充）', () => {
    expect(ticketSlotValue(TICKET_BYTES)).toBe(TICKET_URL_B64);
    expect(ticketSlotValue(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(ticketSlotValue(Uint8Array.from([0]))).toBe('AA');
    expect(ticketSlotValue(TICKET_BYTES)).not.toContain('=');
  });

  it('空票生成会话槽 → ProtocolError（不发出无票帧）', () => {
    expect(() => ticketSlotValue(new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('encodeBase64UrlRaw / decodeBase64Std 互为逆（标准表含 +/）', () => {
    expect(encodeBase64UrlRaw(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
    expect(decodeBase64Std('+/+/')).toEqual(Uint8Array.from([0xfb, 0xff, 0xbf]));
    expect(decodeBase64Std(TICKET_STD_B64)).toEqual(TICKET_BYTES);
    expect(decodeBase64Std('AQID+/8')).toEqual(TICKET_BYTES); // 容忍无填充
    expect(() => decodeBase64Std('AQID-_8')).toThrow(FrameProtocolError); // 标准表不接受 url-safe 字符
  });

  it('buildWsUrl：host:port + path 补 ws:// 并追加 ?ticket=<base64url>', () => {
    const url = buildWsUrl({
      kind: 'ws',
      addr: '10.0.0.9:7100',
      path: '/',
      ticket: TICKET_BYTES,
    });
    expect(url).toBe(`ws://10.0.0.9:7100/?ticket=${TICKET_URL_B64}`);
  });

  it('buildWsUrl：完整 ws://wss:// 地址原样保留；无票不加 query', () => {
    expect(buildWsUrl({ kind: 'ws', addr: 'ws://edge.example:7100/ws' }))
      .toBe('ws://edge.example:7100/ws');
    expect(buildWsUrl({ kind: 'ws', addr: 'wss://edge.example:7100/ws', ticket: TICKET_BYTES }))
      .toBe(`wss://edge.example:7100/ws?ticket=${TICKET_URL_B64}`);
    expect(buildWsUrl({ kind: 'ws', addr: '10.0.0.9:7100' })).toBe('ws://10.0.0.9:7100/ws');
  });
});
