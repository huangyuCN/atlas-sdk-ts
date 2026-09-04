// ProtobufSerializer：基于 @bufbuild/protobuf 的 client.Serializer 可选实现
// （载荷编码 ver=2，规范 §3.1 载荷编码协商；层级镜像 Go contrib/protobuf——
// @bufbuild 依赖归本实现与 ./protobuf 子入口，内核与主入口零 protobuf 依赖）。
//
// 请求/响应 DTO 须为 @bufbuild/protobuf 的 message（protoc-gen-es 生成类型或
// wkt 类型）。与 Go 侧 proto.Message 自描述不同，@bufbuild 的 plain message
// 不携带自身 schema，序列化须按 $typeName 查 schema——由使用方注入 registry
// （createRegistry(...schema) 构建；规范 §3.1 的生成器批次产 op → input/output
// schema 映射后可全自动绑定）。
// protojson（ver=1）永续支持；服务端支持 ver=2 前勿在真实连接启用本实现。
//
// 用法：
//
//	import { ProtobufSerializer } from '@huangyucn/atlas-sdk-ts/protobuf';
//	import { createRegistry } from '@bufbuild/protobuf';
//	import { StringValueSchema } from '@bufbuild/protobuf/wkt';
//	await newClient(dialer, cfg, Kind.Business, [
//	  WithSerializer(new ProtobufSerializer(createRegistry(StringValueSchema))),
//	]);
import {
  createRegistry,
  fromBinary,
  isMessage,
  merge,
  toBinary,
  type Registry,
} from '@bufbuild/protobuf';
import { VERSION_2 } from '../frame/index.js';
import { ProtocolError } from './errors.js';
import type { Serializer } from './serializer.js';

/** ProtobufSerializer 是 protobuf 二进制序列化器（载荷编码 ver=2）。
 * Marshal/Unmarshal 的请求与响应 DTO 须为 @bufbuild/protobuf message；
 * readonly version 实现 frame.Versioned（内核按 serializerVersion 推导
 * ver=2 → 请求帧头声明、响应帧校验，与 Go Version() = frame.Version2 同构）。 */
export class ProtobufSerializer implements Serializer {
  readonly name = 'protobuf';
  readonly version = VERSION_2;

  private readonly registry: Registry;

  /** registry：DTO 类型名 → schema 查找表（createRegistry(...schema) 构建）。 */
  constructor(registry: Registry) {
    this.registry = registry;
  }

  /** 请求对象 → payload 字节（protobuf wire format）。 */
  marshal(req: unknown): Uint8Array {
    if (!isMessage(req)) {
      throw new ProtocolError(`protobuf: 请求 DTO 须为 @bufbuild message，得到 ${typeof req}`);
    }
    const schema = this.registry.getMessage(req.$typeName);
    if (!schema) {
      throw new ProtocolError(`protobuf: 未注册消息 schema: ${req.$typeName}`);
    }
    return toBinary(schema, req);
  }

  /** payload 字节 → 填充目标对象。
   * resp 为 @bufbuild message：按 $typeName 查 schema，按 protobuf 合并语义填充
   * 并返回 resp（接口完整形态，与 JsonSerializer 的 Object.assign 分工对齐）。
   * resp 为 null/undefined（内核「仅解码返回」形态）：protobuf 编码非自描述、
   * 无 schema 不可自动解码——按边界语义返回 payload 原样字节，由调用方按 op 的
   * output schema 自行 fromBinary（生成器产 op → schema 绑定后自动化）。 */
  unmarshal(payload: Uint8Array, resp: unknown): unknown {
    if (resp === null || resp === undefined) {
      return payload;
    }
    if (!isMessage(resp)) {
      throw new ProtocolError(`protobuf: 响应 DTO 须为 @bufbuild message，得到 ${typeof resp}`);
    }
    const schema = this.registry.getMessage(resp.$typeName);
    if (!schema) {
      throw new ProtocolError(`protobuf: 未注册消息 schema: ${resp.$typeName}`);
    }
    merge(schema, resp, fromBinary(schema, payload));
    return resp;
  }
}
