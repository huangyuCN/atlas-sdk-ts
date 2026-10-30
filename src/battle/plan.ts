// 战斗直连「上线包」解析：成局推送（MatchStartedNotify）→ 票据 + 接入层地址。
// 地址优先取**本人票条目**里的逐人 endpoints（多实例接入层按 player_id 哈希选实例，同一玩家
// 恒定同址）；票条目缺失/为空（旧服务端）才回落到回执（事件）级列表——回落不猜端口、不换面。
//
// 零 protobuf 运行时依赖：推送载荷是 protojson（帧头 ver=1）——直接 JSON 解码；
//   - bytes 字段（battle_ticket）按 protojson 约定是**标准 base64（带填充）**；
//   - 枚举字段（endpoints[].transport）按 protojson 默认下发**枚举名**（EDGE_TRANSPORT_*）；
//   - 64 位整数字段按字符串下发（本消息无，帧号解析见 session 的推送提取）。
// 传输面只取本 SDK 支持的面：TS（浏览器）只有 WS，**缺 WS 面即明确报错**
// （不得回退猜端口、不得静默换面——见规格 §2.1/§7）。
import { decodeBase64Std } from '../frame/base64.js';
import { decodeUtf8 } from '../frame/utf8.js';
import { ProtocolError } from '../client/errors.js';

/** EdgeTransport 接入层传输面（protojson 下发枚举名；与 battle.v1.EdgeTransport 同值）。 */
export const EdgeTransport = {
  Unspecified: 'EDGE_TRANSPORT_UNSPECIFIED',
  Ws: 'EDGE_TRANSPORT_WS',
  Kcp: 'EDGE_TRANSPORT_KCP',
  Udp: 'EDGE_TRANSPORT_UDP',
} as const;
export type EdgeTransport = (typeof EdgeTransport)[keyof typeof EdgeTransport];

/** 已知传输面集合（未知枚举名忽略，不猜面；UNSPECIFIED 是**协议违背**，另行拒绝）。 */
const KNOWN_TRANSPORTS: readonly string[] = [EdgeTransport.Ws, EdgeTransport.Kcp, EdgeTransport.Udp];

/** MATCH_STARTED_NOTIFY_OPS 成局推送的 op 形态（**只认消息完整名**）：
 *  推送按**消息完整名**寻址，生成 stub（playerServicePushOps.matchStartedNotify）与网关
 *  实际下发用的都是 `/game.v1.MatchStartedNotify`；`/game.v1.PlayerService/MatchStartedNotify`
 *  是服务/方法名（RPC 调用口径），**不接受**——放宽会让「op 口径不一致」被静默掩盖。
 *  与 Go SDK 的 direct.PushOpMatchStarted 逐字一致。 */
export const MATCH_STARTED_NOTIFY_OPS: readonly string[] = ['/game.v1.MatchStartedNotify'];

/** isMatchStartedNotifyOp 判定推送 op 是否为成局通知。 */
export function isMatchStartedNotifyOp(op: string): boolean {
  return MATCH_STARTED_NOTIFY_OPS.includes(op);
}

/** DirectPlan 是一条战斗直连的上线包：对局标识、本人票据与接入层面地址表。 */
export interface DirectPlan {
  /** 对局 ID（信息字段，可能为空串）。 */
  readonly matchId: string;
  /** 战斗 ID（入局/补帧请求的客体寻址字段；消息类型属游戏协议包）。 */
  readonly battleId: string;
  /** 本人那张入场票据密文（AEAD 密文；升级 query 与帧会话槽都用它）。 */
  readonly ticket: Uint8Array;
  /** 传输面 → 接入层地址（host:port）：**本人票条目**里的实例地址优先，缺失才取回执级列表。 */
  readonly endpoints: ReadonlyMap<EdgeTransport, string>;
}

/** parseDirectPlan 解析成局推送：接受原始 protojson 字节、JSON 文本或已解码对象；
 *  载荷为推送信封 `{type,payload}` 时自动解包。地址取**本人票条目**里的逐人 endpoints
 *  （多实例按 player_id 哈希选定实例，同一玩家恒定同址），票条目缺失/为空才回落到
 *  回执（事件）级列表。缺票/空票/缺 battle_id/缺 WS 面一律抛 ProtocolError
 *  （既有错误类型，不新增异常族）。 */
export function parseDirectPlan(notify: Uint8Array | string | Record<string, unknown>): DirectPlan {
  const payload = notifyObject(notify);
  const battleId = strField(payload, 'battleId');
  if (battleId === '') {
    throw new ProtocolError('battle: 成局通知缺 battle_id，无法定位战斗');
  }
  const ticket = decodeTicket(strField(payload, 'battleTicket'));
  const endpoints = resolveEndpoints(payload, ticket);
  if (!endpoints.has(EdgeTransport.Ws)) {
    throw new ProtocolError(
      `battle: 成局通知的 endpoints 缺 ${EdgeTransport.Ws} 面（TS 只有 WS 面：不猜端口、不换面）`,
    );
  }
  return { matchId: strField(payload, 'matchId'), battleId, ticket, endpoints };
}

/** notifyObject 归一化推送载荷为字面量对象（字节/文本 → JSON；信封自动解包）。 */
function notifyObject(notify: Uint8Array | string | Record<string, unknown>): Record<string, unknown> {
  let value: unknown = notify;
  if (notify instanceof Uint8Array) {
    value = parseJsonBytes(notify);
  } else if (typeof notify === 'string') {
    value = parseJsonText(notify);
  }
  if (!isPlainObject(value)) {
    throw new ProtocolError('battle: 成局通知载荷不是 JSON 对象');
  }
  const inner = value['payload'];
  if (typeof value['type'] === 'string' && isPlainObject(inner)) return inner;
  return value;
}

/** parseJsonBytes 解析 protojson 字节（非法 JSON 归协议错误）。 */
function parseJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.length === 0) throw new ProtocolError('battle: 成局通知载荷为空');
  return parseJsonText(decodeUtf8(bytes));
}

/** parseJsonText 解析 JSON 文本（非法 JSON 归协议错误）。 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ProtocolError('battle: 成局通知载荷不是合法 JSON', err);
  }
}

/** isPlainObject 判定字面量对象（数组/null 不算）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** strField 取字符串字段（非字符串/缺失按空串）。 */
function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

/** decodeTicket 解码 battle_ticket：缺失/空串/非法 base64/空密文都显式报错
 *（空票连不上接入层，绝不能静默降级）。 */
function decodeTicket(encoded: string): Uint8Array {
  if (encoded === '') {
    throw new ProtocolError('battle: 成局通知缺 battle_ticket（空票连不上接入层）');
  }
  let ticket: Uint8Array;
  try {
    ticket = decodeBase64Std(encoded);
  } catch (err) {
    // 帧层 base64 哨兵收敛为内核既有 ProtocolError（不新增异常类型族；cause 留原始错误）。
    throw new ProtocolError('battle: battle_ticket 不是合法标准 base64', err);
  }
  if (ticket.length === 0) {
    throw new ProtocolError('battle: battle_ticket 解码后为空');
  }
  return ticket;
}

/** TICKET_LIST_KEYS 逐人票条目列表的键名：回执（IssueEntryTicketReply.tickets）与事件
 *（MatchStartedEvent.battle_tickets）同形，两套命名口径都认（proto 名 / protojson 默认键名）。 */
const TICKET_LIST_KEYS: readonly string[] = ['tickets', 'battle_tickets', 'battleTickets'];

/** resolveEndpoints 返回本玩家实际要拨的面列表：**优先**票条目里的逐人 endpoints（多实例接入层
 *按 player_id 哈希选实例，同一玩家恒定同址），条目缺失/为空/对不上本人票即回落到回执（事件）级
 *endpoints——旧服务端只下发该列表，兼容路径行为不变（不猜端口、不静默换面）。 */
function resolveEndpoints(
  payload: Record<string, unknown>,
  ticket: Uint8Array,
): Map<EdgeTransport, string> {
  const perPlayer = ticketEntryEndpoints(payload, ticket);
  return perPlayer.size > 0 ? perPlayer : parseEndpoints(payload['endpoints']);
}

/** ticketEntryEndpoints 取「本人那一份」票条目的面列表：条目按票密文逐字节匹配（身份由票本身
 *确定，**不取第一条**、不猜）；无列表/无匹配/该条目未下发面都返回空表，由调用方回落。 */
function ticketEntryEndpoints(
  payload: Record<string, unknown>,
  ticket: Uint8Array,
): Map<EdgeTransport, string> {
  for (const key of TICKET_LIST_KEYS) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    const found = entryEndpointsOf(list, ticket);
    if (found.size > 0) return found;
  }
  return new Map<EdgeTransport, string>();
}

/** entryEndpointsOf 在票条目列表里找本人那张票，返回其面列表（没有匹配即空表）。 */
function entryEndpointsOf(
  list: readonly unknown[],
  ticket: Uint8Array,
): Map<EdgeTransport, string> {
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    if (!isOwnTicket(strField(entry, 'ticket'), ticket)) continue;
    const endpoints = parseEndpoints(entry['endpoints']);
    if (endpoints.size > 0) return endpoints;
  }
  return new Map<EdgeTransport, string>();
}

/** isOwnTicket 判断票条目里的票密文是否就是本人那张（base64 解码后逐字节比较）。坏编码一律
 *视为「不是本人」而不抛错：回落路径仍能连上旧服务端，别让脏条目把整条上线链路打死。 */
function isOwnTicket(encoded: string, ticket: Uint8Array): boolean {
  if (encoded === '') return false;
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Std(encoded);
  } catch {
    return false;
  }
  if (decoded.length !== ticket.length) return false;
  for (let i = 0; i < decoded.length; i += 1) {
    if (decoded[i] !== ticket[i]) return false;
  }
  return true;
}

/** parseEndpoints 解析 endpoints[] 为「面 → 地址」表：未知面名/空地址条目忽略
 *（不猜面）；同面重复时后者覆盖。**UNSPECIFIED 显式拒绝**——proto 注明该值「不得下发」
 *（面必须显式指定），静默忽略会让「服务端漏配面」伪装成「客户端没这个面」。 */
function parseEndpoints(raw: unknown): Map<EdgeTransport, string> {
  const out = new Map<EdgeTransport, string>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const transport = strField(entry, 'transport');
    if (transport === EdgeTransport.Unspecified) {
      throw new ProtocolError(
        `battle: endpoints 下发 ${EdgeTransport.Unspecified}（proto 明示不得下发：传输面必须显式指定）`,
      );
    }
    const address = strField(entry, 'address');
    if (address === '' || !KNOWN_TRANSPORTS.includes(transport)) continue;
    out.set(transport as EdgeTransport, address);
  }
  return out;
}
