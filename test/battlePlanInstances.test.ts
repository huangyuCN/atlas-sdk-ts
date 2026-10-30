// 逐人 endpoints 用例：多实例接入层按 player_id 哈希选实例，服务端把「该玩家被选中的实例」的
// 面列表写进**票条目**（BattleTicketEntry.endpoints）。SDK 必须优先读自己票条目里的地址，
// 票条目缺失/为空（旧服务端）才回落到回执（事件）级 endpoints（= 首实例）。
import { describe, expect, it } from 'vitest';
import { EdgeTransport, ProtocolError, parseDirectPlan } from '../src/index.js';

/** 两玩家的票密文（标准 base64；身份由票本身确定，SDK 不猜、不取第一条）。 */
const TICKET_P1 = 'AQIDBA=='; // 0x01 0x02 0x03 0x04
const TICKET_P2 = 'BQYHCA=='; // 0x05 0x06 0x07 0x08

/** firstInstance 是回执（事件）级 endpoints：服务端取**首个实例**的面列表，仅作旧客户端兜底。 */
const FIRST_INSTANCE = '10.0.0.1:7100';

/** entriesAB 是两玩家的票条目：p-1 → 实例 A，p-2 → 实例 B。 */
const ENTRIES_AB = [
  {
    playerId: 'p-1',
    ticket: TICKET_P1,
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: 'edge-a.example.com:7100' }],
  },
  {
    playerId: 'p-2',
    ticket: TICKET_P2,
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: 'edge-b.example.com:7100' }],
  },
];

/** notifyWithEntries 组装「带逐人票条目」的成局推送（battle_ticket = 本人那张票）。 */
function notifyWithEntries(ownTicket: string, tickets: unknown): Record<string, unknown> {
  return {
    matchId: 'm-1',
    battleId: 'b-1',
    playerIds: ['p-1', 'p-2'],
    battleTicket: ownTicket,
    endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: FIRST_INSTANCE }],
    tickets,
  };
}

describe('parseDirectPlan 逐人 endpoints 优先', () => {
  it('① 票条目带逐人 endpoints ⇒ 用它而不是回执级首实例', () => {
    const plan = parseDirectPlan(notifyWithEntries(TICKET_P1, ENTRIES_AB));
    expect(plan.endpoints.get(EdgeTransport.Ws)).toBe('edge-a.example.com:7100');
  });

  it('② 票条目缺失/无面/空面/无本人 ⇒ 回落回执级列表（旧服务端兼容）', () => {
    const cases: Record<string, unknown> = {
      '没有逐人票条目列表': undefined,
      '票条目无 endpoints 字段': [{ playerId: 'p-1', ticket: TICKET_P1 }],
      '票条目 endpoints 为空': [{ playerId: 'p-1', ticket: TICKET_P1, endpoints: [] }],
      '票条目里没有本人': [{ playerId: 'p-2', ticket: TICKET_P2, endpoints: ENTRIES_AB[1]!.endpoints }],
    };
    for (const [name, tickets] of Object.entries(cases)) {
      const plan = parseDirectPlan(notifyWithEntries(TICKET_P1, tickets));
      expect(plan.endpoints.get(EdgeTransport.Ws), name).toBe(FIRST_INSTANCE);
    }
  });

  it('③ 同一玩家多次解析 ⇒ 同一地址；不同玩家 ⇒ 各自实例', () => {
    const first = parseDirectPlan(notifyWithEntries(TICKET_P1, ENTRIES_AB));
    const want = first.endpoints.get(EdgeTransport.Ws);
    expect(want).toBe('edge-a.example.com:7100');
    for (let i = 0; i < 3; i += 1) {
      const again = parseDirectPlan(notifyWithEntries(TICKET_P1, ENTRIES_AB));
      expect(again.endpoints.get(EdgeTransport.Ws), `第 ${i + 1} 次`).toBe(want);
    }
    // 同一份条目列表换个本人票：必须落到另一个实例（不是条目顺序决定的）。
    const other = parseDirectPlan(notifyWithEntries(TICKET_P2, ENTRIES_AB));
    expect(other.endpoints.get(EdgeTransport.Ws)).toBe('edge-b.example.com:7100');
    expect(other.endpoints.get(EdgeTransport.Ws)).not.toBe(want);
  });

  it('事件形态的列表键名（battleTickets）同样认', () => {
    const payload = {
      matchId: 'm-1',
      battleId: 'b-1',
      battleTicket: TICKET_P1,
      endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: FIRST_INSTANCE }],
      battleTickets: [
        {
          playerId: 'p-1',
          ticket: TICKET_P1,
          endpoints: [{ transport: 'EDGE_TRANSPORT_WS', address: 'edge-a.example.com:7100' }],
        },
      ],
    };
    const plan = parseDirectPlan(payload);
    expect(plan.endpoints.get(EdgeTransport.Ws)).toBe('edge-a.example.com:7100');
  });

  it('票条目只下发非 WS 面（TS 只有 WS）⇒ 不静默换实例，明确报错', () => {
    const tickets = [
      {
        playerId: 'p-1',
        ticket: TICKET_P1,
        endpoints: [{ transport: 'EDGE_TRANSPORT_KCP', address: 'edge-a.example.com:7101' }],
      },
    ];
    expect(() => parseDirectPlan(notifyWithEntries(TICKET_P1, tickets))).toThrow(ProtocolError);
  });
});
