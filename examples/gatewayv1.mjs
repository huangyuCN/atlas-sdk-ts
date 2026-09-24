// gatewayv1 schema 与「会话协议接缝参考实现」（JS 版）：真机冒烟用的 DTO/schema 装配。
//
// 单一来源：schema 与 op 名全部来自模板仓 api/gateway/v1/session.proto 与
// api/battle/v1/battle_service.proto 的 descriptor set（scripts/gen-dto.sh 用
// protoc-gen-es 生成到 examples/gen/，不 vendored .proto、不手写 descriptor）。
// 本模块把这些生成物组装成两件事：
//   1. 冒烟用 registry/schemas（ProtobufSerializer 的 ver=2 编码）；
//   2. gatewayV1SessionProtocol——项目侧接入 SDK 的「一行接缝」示例（op 名由生成
//      的服务描述符推导，凭据/原因字段名按生成 DTO 读取）。
import { create, createRegistry, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  HeartbeatReplySchema,
  HeartbeatRequestSchema,
  KickedNotifySchema,
  KickedReasonSchema,
  LoginReplySchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RegisterReplySchema,
  RegisterRequestSchema,
  ResumeReplySchema,
  ResumeRequestSchema,
  Session as SessionService,
} from './gen/api/gateway/v1/session_pb.js';
import {
  JoinBattleReplySchema,
  JoinBattleReqSchema,
  BattleService,
} from './gen/api/battle/v1/battle_service_pb.js';

/** rpcOp 由生成的服务描述符推导客户端 op 全名（/包.服务/方法）——op 寻址键的
 * 唯一来源是 proto，示例里不写字符串字面量。 */
const rpcOp = (service, method) => `/${service.typeName}/${service.method[method].name}`;

/** sessionOps 是会话生命周期的 5 个 op（对应模板 Session 服务的 5 个 rpc）。 */
export const sessionOps = {
  register: rpcOp(SessionService, 'register'),
  login: rpcOp(SessionService, 'login'),
  resume: rpcOp(SessionService, 'resume'),
  logout: rpcOp(SessionService, 'logout'),
  heartbeat: rpcOp(SessionService, 'heartbeat'),
};

/** kickedNotifyOp 是被挤下线推送的 op（推送按消息全名寻址）。 */
export const kickedNotifyOp = `/${KickedNotifySchema.typeName}`;

/** joinBattleOp 是战斗通道加入战斗的 op（battle 域 CLIENT 方法）。 */
export const joinBattleOp = rpcOp(BattleService, 'joinBattle');

// registry：ProtobufSerializer 用的类型名 → schema 查找表（ver=2 载荷编解码）。
export const registry = createRegistry(
  RegisterRequestSchema,
  RegisterReplySchema,
  LoginRequestSchema,
  LoginReplySchema,
  ResumeRequestSchema,
  ResumeReplySchema,
  LogoutRequestSchema,
  HeartbeatRequestSchema,
  HeartbeatReplySchema,
  JoinBattleReqSchema,
  JoinBattleReplySchema,
);

export const schemas = {
  RegisterRequest: RegisterRequestSchema,
  RegisterReply: RegisterReplySchema,
  LoginRequest: LoginRequestSchema,
  LoginReply: LoginReplySchema,
  HeartbeatRequest: HeartbeatRequestSchema,
  HeartbeatReply: HeartbeatReplySchema,
  JoinBattleReq: JoinBattleReqSchema,
  JoinBattleReply: JoinBattleReplySchema,
};

export function newMsg(schema, data) {
  return create(schema, data);
}

export function toPb(schema, msg) {
  return toBinary(schema, msg);
}

export function fromPb(schema, data) {
  // @bufbuild fromBinary(schema, bytes) 返回新 message（第三参是 options 非 target）
  return fromBinary(schema, data);
}

/** asObject 把回执规整成可读字段的对象：ver=1（protojson）下序列化器已解成对象；
 * ver=2（protobuf）下是非自描述原始字节，按传入 schema 解码。 */
function asObject(schema, msg) {
  if (msg instanceof Uint8Array) return msg.length === 0 ? null : fromBinary(schema, msg);
  return msg ?? null;
}

/** reasonName 把解码结果规整为「枚举名」语义（S0.5：原因标识=枚举名）：
 * protojson（ver=1）本就是枚举名；protobuf（ver=2）解出的是枚举数值，经 enum
 * schema 还原为 proto 全名（如 KICKED_REASON_LOGGED_IN_ELSEWHERE），两种编码一致。 */
function reasonName(value) {
  if (typeof value !== 'number') return value ?? '';
  return KickedReasonSchema.values.find((v) => v.number === value)?.name ?? '';
}

/** newGatewayV1SessionProtocol 按 S0.5 冻结形状（含修订 1）组装会话协议接缝：5 个 op +
 * 3 个解码钩子（token / playerID / expiresAt）+ 1 个推送识别。被挤下线推送按**推送信封的
 * 帧头 version** 选择解码器（1 = protojson 字节、2 = protobuf wire 字节）——载荷非自描述，
 * 丢掉 version 会让 ver=2 的原因静默丢失（S0.5 修订 1 · c②）；未知 version 不猜编码、
 * 不抛错（推送分发在读循环内，异常会打断连接）。
 * 项目侧真实接入即此形态：newSession([withSessionProtocol(newGatewayV1SessionProtocol())])。 */
export function newGatewayV1SessionProtocol() {
  return {
    ops: () => sessionOps,
    token: (msg) => asObject(LoginReplySchema, msg)?.token ?? '',
    playerID: (msg) => asObject(LoginReplySchema, msg)?.playerId ?? '',
    // 模板协议当前无 expiry 字段（R13）：可选钩子恒 0，本轮不启用续期。
    expiresAt: () => 0,
    kicked: (op, envelope) => {
      if (op !== kickedNotifyOp) return { reason: '', ok: false };
      // envelope 是推送信封 {op, version, body}：body 为未解码原始字节（SDK 原样透传）。
      // 空载荷/坏字节/未知 version 按「识别为被挤下线但无原因」处理，不抛错。
      return { reason: decodeKickedReason(envelope), ok: true };
    },
  };
}

/** decodeKickedReason 按帧头 version 解码被挤下线原因并归一为「枚举名」语义：
 * ver=1（protojson）本就是枚举名；ver=2（protobuf wire）解出枚举数值，经 enum schema
 * 还原为 proto 全名（如 KICKED_REASON_LOGGED_IN_ELSEWHERE），两种编码结果一致。
 * 未知 version / 空载荷 / 坏字节一律返回空串且不抛错。 */
function decodeKickedReason(envelope) {
  const body = envelope?.body;
  if (!(body instanceof Uint8Array) || body.length === 0) return '';
  try {
    if (envelope.version === 1) {
      return reasonName(JSON.parse(new TextDecoder().decode(body)).reason);
    }
    if (envelope.version === 2) {
      return reasonName(fromBinary(KickedNotifySchema, body).reason);
    }
  } catch {
    return '';
  }
  return ''; // 未知 version：版本不可信则不猜编码
}

/** gatewayV1SessionProtocol 是默认（ver=1 protojson 载荷）的接缝实现。 */
export const gatewayV1SessionProtocol = newGatewayV1SessionProtocol();
