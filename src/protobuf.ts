// protobuf 子入口（import '@huangyucn/atlas-sdk-ts/protobuf'）：
// 主入口（'.'）的超集——额外含 @bufbuild/protobuf 依赖的 ProtobufSerializer
// （载荷编码 ver=2，层级镜像 Go contrib/protobuf）。主入口零 protobuf 依赖：
// 只用 JSON 序列化的业务引用主入口，bundle 不会拉到 @bufbuild。
import { ProtobufSerializer } from './client/protobufserializer.js';

export * from './index.js';
export { ProtobufSerializer };
