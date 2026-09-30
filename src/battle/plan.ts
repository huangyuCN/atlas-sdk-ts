// 战斗直连「上线包」解析：成局推送（MatchStartedNotify）→ 票据 + 接入层地址。
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

/** 已知传输面集合（未知枚举名忽略，不猜面）。 */
const KNOWN_TRANSPORTS: readonly string[] = Object.values(EdgeTransport);

/** MATCH_STARTED_NOTIFY_OPS 成局推送的 op 形态（两种都接受）：
 *   - `/game.v1.MatchStartedNotify`：protojson 推送按**消息完整名**寻址，生成 stub
 *     （playerServicePushOps.matchStartedNotify）与网关实际下发用的都是这个；
 *   - `/game.v1.PlayerService/MatchStartedNotify`：服务限定名形态（任务书口径），
 *     一并接受，避免两侧命名口径不一致时静默收不到成局通知。 */
export const MATCH_STARTED_NOTIFY_OPS: readonly string[] = [
  '/game.v1.MatchStartedNotify',
  '/game.v1.PlayerService/MatchStartedNotify',
];

/** isMatchStartedNotifyOp 判定推送 op 是否为成局通知。 */
export function isMatchStartedNotifyOp(op: string): boolean {
  return MATCH_STARTED_NOTIFY_OPS.includes(op);
}

/** DirectPlan 是一条战斗直连的上线包：对局标识、本人票据与接入层面地址表。 */
export interface DirectPlan {
  /** 对局 ID（信息字段，可能为空串）。 */
  readonly matchId: string;
  /** 战斗 ID（JoinBattle/SyncFrames 的客体寻址字段）。 */
  readonly battleId: string;
  /** 本人那张入场票据密文（AEAD 密文；升级 query 与帧会话槽都用它）。 */
  readonly ticket: Uint8Array;
  /** 传输面 → 接入层地址（host:port）。 */
  readonly endpoints: ReadonlyMap<EdgeTransport, string>;
}

/** parseDirectPlan 解析成局推送：接受原始 protojson 字节、JSON 文本或已解码对象；
 *  载荷为推送信封 `{type,payload}` 时自动解包。缺票/空票/缺 battle_id/缺 WS 面
 *  一律抛 ProtocolError（既有错误类型，不新增异常族）。 */
export function parseDirectPlan(notify: Uint8Array | string | Record<string, unknown>): DirectPlan {
  const payload = notifyObject(notify);
  const battleId = strField(payload, 'battleId');
  if (battleId === '') {
    throw new ProtocolError('battle: 成局通知缺 battle_id，无法定位战斗');
  }
  const ticket = decodeTicket(strField(payload, 'battleTicket'));
  const endpoints = parseEndpoints(payload['endpoints']);
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

/** parseEndpoints 解析 endpoints[] 为「面 → 地址」表：未知面名/空地址条目忽略
 *（不猜面）；同面重复时后者覆盖。 */
function parseEndpoints(raw: unknown): Map<EdgeTransport, string> {
  const out = new Map<EdgeTransport, string>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const transport = strField(entry, 'transport');
    const address = strField(entry, 'address');
    if (address === '' || !KNOWN_TRANSPORTS.includes(transport)) continue;
    out.set(transport as EdgeTransport, address);
  }
  return out;
}
