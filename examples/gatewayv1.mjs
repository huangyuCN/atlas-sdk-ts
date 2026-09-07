// gatewayv1 schema（JS 版）：真机冒烟 protobuf 编码用 gateway 认证协议最小 schema。
// 字段与 atlas-game-layout api/gateway/v1/auth.proto 对齐（去跨包 PlayerSummary）。
// 统一官方栈（三库对齐路线 B）：schema 由 protoc-gen-es 生成（examples/proto/gen/），
// 本模块 re-export 并组装成冒烟用的 registry/schemas 接口——不再手写 descriptor。
// 生成命令见 scripts/gen-dto.sh（proto → gen 单源，防手写漂移）。
import { create, createRegistry, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  HeartbeatReplySchema,
  HeartbeatRequestSchema,
  JoinBattleReplySchema,
  JoinBattleRequestSchema,
  LoginReplySchema,
  LoginRequestSchema,
  RegisterReplySchema,
  RegisterRequestSchema,
} from './proto/gen/gatewayv1/auth_pb.js';

// registry：ProtobufSerializer 用的类型名 → schema 查找表。
export const registry = createRegistry(
  RegisterRequestSchema,
  RegisterReplySchema,
  LoginRequestSchema,
  LoginReplySchema,
  HeartbeatRequestSchema,
  HeartbeatReplySchema,
  JoinBattleRequestSchema,
  JoinBattleReplySchema,
);

export const schemas = {
  RegisterRequest: RegisterRequestSchema,
  RegisterReply: RegisterReplySchema,
  LoginRequest: LoginRequestSchema,
  LoginReply: LoginReplySchema,
  HeartbeatRequest: HeartbeatRequestSchema,
  HeartbeatReply: HeartbeatReplySchema,
  JoinBattleRequest: JoinBattleRequestSchema,
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
