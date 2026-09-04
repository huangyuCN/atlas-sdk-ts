// gatewayv1 schema（JS 版）：真机冒烟 protobuf 编码用 gateway 认证协议最小 schema。
// 字段与 atlas-game-layout api/gateway/v1/auth.proto 对齐（去跨包 PlayerSummary）。
// 运行时动态构造 FileDescriptorSet → registry（protoc-gen-es 在此环境不可用，
// 动态构造与生成物同语义、字段 wire 一致）。
import {
  create,
  createFileRegistry,
  createRegistry,
  fromBinary,
  toBinary,
} from '@bufbuild/protobuf';
import {
  FieldDescriptorProtoSchema,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';

const T_STRING = 9;
const T_INT64 = 3;
const T_UINT64 = 4;
const L_OPT = 1;

const strField = (name, number) =>
  create(FieldDescriptorProtoSchema, { name, number, label: L_OPT, type: T_STRING, jsonName: name });
const i64Field = (name, number) =>
  create(FieldDescriptorProtoSchema, { name, number, label: L_OPT, type: T_INT64, jsonName: name });
const u64Field = (name, number) =>
  create(FieldDescriptorProtoSchema, { name, number, label: L_OPT, type: T_UINT64, jsonName: name });

const fd = create(FileDescriptorProtoSchema, {
  name: 'auth.proto',
  package: 'gateway.v1',
  syntax: 'proto3',
  messageType: [
    { name: 'RegisterRequest', field: ['account', 'password', 'nickname'].map((n, i) => strField(n, i + 1)) },
    { name: 'RegisterReply', field: [strField('player_id', 1)] },
    { name: 'LoginRequest', field: ['player_id', 'password'].map((n, i) => strField(n, i + 1)) },
    { name: 'LoginReply', field: [strField('player_id', 1), strField('token', 2)] },
    { name: 'HeartbeatRequest', field: [strField('token', 1), strField('player_id', 2), i64Field('ts', 3)] },
    { name: 'HeartbeatReply', field: [i64Field('ts', 1), u64Field('server_time_unix_ms', 2)] },
  ],
});

export const registry = createFileRegistry(create(FileDescriptorSetSchema, { file: [fd] }));

export const schemas = {
  RegisterRequest: registry.getMessage('gateway.v1.RegisterRequest'),
  RegisterReply: registry.getMessage('gateway.v1.RegisterReply'),
  LoginRequest: registry.getMessage('gateway.v1.LoginRequest'),
  LoginReply: registry.getMessage('gateway.v1.LoginReply'),
  HeartbeatRequest: registry.getMessage('gateway.v1.HeartbeatRequest'),
  HeartbeatReply: registry.getMessage('gateway.v1.HeartbeatReply'),
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
