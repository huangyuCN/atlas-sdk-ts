// 会话协议接缝 SessionProtocol（R13 / S0.5 冻结形状 + 修订 1）。
//
// 会话状态机（Session + 内置心跳 + 断线恢复）只依赖本接口，不引用任何会话消息类型：
// 5 个会话 op 名、3 个回执解码钩子（token / playerID / expiresAt）与 1 个推送识别
// （被挤下线判定 + 原因提取）。op 名与字段名由项目侧**生成的会话 stub** 提供——
// 模板仓 api/gateway/v1/opclient/session_pb.ts 的 SessionProtocolOps /
// sessionToken / sessionPlayerID / sessionExpiresAt / sessionPushOps，
// 本仓快照见 src/gen/api/gateway/v1/opclient/session_pb.ts（scripts/gen-dto.sh 产出）。
//
// 接入方式（项目侧一行）：newSession([withSessionProtocol(gatewayV1Protocol())])。
// 形状已在 S0.5 冻结（修订 1 仅把推送识别的载荷改为推送信封），三语言（Go/TS/C#）
// 不得各自加字段（本轮不加续期/刷新、多端标识、序列化器选择——序列化归 Serializer 插槽）。
//
// 约束（项目侧必须满足）：SDK 内核不认识任何会话消息类型，回执解码完全由接缝实现承担
// ——项目**必须提供并链接生成的会话 DTO**（模板仓 opclient 产物或其等价物），并在其上
// 实现 3 个提取钩子；否则会话回执解析不出关键凭据，Session 会抛
// SessionReplyUnresolvedError 而不是静默成功（ver=2 protobuf 字节非自描述，尤其需要
// 生成 DTO 的 schema 才能解码）。
import type { SessionOption } from './session.js';

/** SessionOps 是会话生命周期的 5 个 op 名（register / login / resume / logout /
 * heartbeat）；接缝是这些 op 的唯一来源，状态机内不写字面量。 */
export interface SessionOps {
  /** 注册（建立会话前的账号创建）。 */
  register: string;
  /** 登录（回执下发会话凭据）。 */
  login: string;
  /** 断线重连免密恢复会话。 */
  resume: string;
  /** 登出（服务端清理会话）。 */
  logout: string;
  /** 会话心跳（无 payload；服务端按连接或帧会话槽续租）。 */
  heartbeat: string;
}

/** PushEnvelope 是推送信封（S0.5 修订 1）：一条服务端推送的完整身份信息。
 * 帧头 version 决定 body 的编码——1 = JSON（protojson）字节、2 = protobuf wire 字节；
 * SDK 不做解码，实现方按 version 选择解码器（生成 DTO 的 protojson 或 schema 解码）。 */
export interface PushEnvelope {
  /** 推送 op（消息全名寻址，即生成物声明的被挤下线推送 op）。 */
  op: string;
  /** 帧头载荷编码版本：1 = JSON（protojson）、2 = protobuf wire。 */
  version: number;
  /** 未解码的推送原始字节。 */
  body: Uint8Array;
}

/** KickedResult 是「被挤下线」推送的识别结果。 */
export interface KickedResult {
  /** ok=true 表示该 op 是被挤下线推送（否则状态机忽略该推送）。 */
  ok: boolean;
  /** 原因标识（生成物的枚举名，如 KICKED_REASON_LOGGED_IN_ELSEWHERE）；
   * 命中推送但取不到原因字段时为空串（对未知/空载荷安全）。 */
  reason: string;
}

/** SessionProtocol 是会话协议接缝：5 个 op + 3 个解码钩子 + 1 个推送识别。
 * 实现由项目侧基于模板生成的会话 stub 提供（examples/gatewayv1.mjs 给了一行示例）。 */
export interface SessionProtocol {
  /** Ops 返回 5 个会话 op 名（接缝是唯一来源）。 */
  ops(): SessionOps;
  /** Token 从会话请求/回执取凭据；无该字段返回空串（可选钩子语义）。 */
  token(msg: unknown): string;
  /** PlayerID 从会话请求/回执取玩家 ID；无该字段返回空串。 */
  playerID(msg: unknown): string;
  /** ExpiresAt 从会话请求/回执取过期时间（毫秒时间戳）；无 expiry 字段返回 0
   * （本轮模板协议无该字段，故不启用续期，R13）。 */
  expiresAt(msg: unknown): number;
  /** Kicked 判定推送 op 是否为「被挤下线」并提取原因。
   *
   * `op` 是分发 op，`payload` 是**推送信封**（含 op、帧头 version 与未解码原始字节）。
   * 实现方须按 `payload.version` 选择解码器（1 → protojson、2 → protobuf wire），
   * 用生成的 `KickedNotify` DTO（模板仓库会 stub）解码后取 `reason`；`op` 未命中被挤
   * 下线推送时返回 `{ok:false}`。载荷为空/解码失败/version 未知时返回
   * `{ok:true, reason:''}`（识别为被挤下线但取不到原因），**一律不得抛错**——
   * 推送分发在读循环内，异常会打断连接。 */
  kicked(op: string, payload: PushEnvelope): KickedResult;
}

/** withSessionProtocol 接入会话协议接缝；不接入时 Session 的会话方法显式报错
 * （SDK 不留任何 gateway.v1 默认副本）。 */
export function withSessionProtocol(protocol: SessionProtocol): SessionOption {
  return (s) => {
    s.protocol = protocol;
  };
}
