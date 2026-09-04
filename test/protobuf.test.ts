// ProtobufSerializer 测试（对齐 atlas-sdk-go/contrib/protobuf/serializer_test.go +
// client/ver_test.go 的 DTO 形态）：
//   - wkt StringValue（Go wrapperspb.StringValue 镜像）往返、ver=2 声明与内核推导、
//     非 @bufbuild message 入参报错；
//   - 端到端：@bufbuild DTO 下 invoke 全链（请求帧头声明 ver=2 + 服务端按 ver 解码
//     回 ver=2 帧；ver 不一致失步终止）；
//   - 边界：内核「resp=null 仅解码」形态返回 payload 原样字节（protobuf 编码非自
//     描述、无 schema 不可自动解码），由调用方按 op 的 output schema 自行 fromBinary
//     （规范 §3.1：生成器产 op → schema 绑定属后续批次）。
import { describe, expect, it } from 'vitest';
import { create, createRegistry, fromBinary, toBinary } from '@bufbuild/protobuf';
import { StringValueSchema, TimestampSchema, type StringValue } from '@bufbuild/protobuf/wkt';
import {
  Kind,
  ProtocolError,
  VERSION,
  VERSION_2,
  WithSerializer,
  newClient,
  type Client,
} from '../src/index.js';
import { ProtobufSerializer } from '../src/protobuf.js';
import { serializerVersion } from '../src/client/serializer.js';
import { buildReplyOK, makeDialer, waitFor } from './helpers.js';

const registry = createRegistry(StringValueSchema);

/** 服务端侧解码请求 payload（对齐 Go ver_test 的 proto.Unmarshal 钩子形态）。 */
function parseStringValue(body: Uint8Array): string {
  return fromBinary(StringValueSchema, body).value;
}

/** 服务端侧编码响应 payload（对齐 Go ver_test 的 proto.Marshal 钩子形态）。 */
function buildStringValue(v: string): Uint8Array {
  return toBinary(StringValueSchema, create(StringValueSchema, { value: v }));
}

describe('ProtobufSerializer（ver=2，镜像 Go contrib/protobuf）', () => {
  it('往返：StringValue 请求 → wire 字节（含 UTF-8 字节）→ 目标填充', () => {
    const s = new ProtobufSerializer(registry);
    const req = create(StringValueSchema, { value: '你好 atlas' });
    const data = s.marshal(req);
    const text = new TextDecoder().decode(data);
    expect(text).toContain('你好'); // protobuf 二进制应含 UTF-8 字符串字节（对齐 Go 断言口径）
    const target = create(StringValueSchema);
    const got = s.unmarshal(data, target) as StringValue;
    expect(got).toBe(target); // resp 目标填充：按 protobuf 合并语义填充并返回 resp 实例
    expect(got.value).toBe('你好 atlas');
  });

  it('ver 声明：实现 frame.Versioned 声明 ver=2，内核推导取声明值（对齐 Go TestSerializerVersion）', () => {
    const s = new ProtobufSerializer(registry);
    expect(s.version).toBe(VERSION_2);
    expect(serializerVersion(s)).toBe(VERSION_2); // WithSerializer 后通道 ver 推导为 2
  });

  it('入参拒绝：非 @bufbuild message 的请求/响应 DTO 报错（对齐 Go TestSerializerRejectsNonMessage）', () => {
    const s = new ProtobufSerializer(registry);
    expect(() => s.marshal({ a: 1 })).toThrow(ProtocolError); // plain object 非 message
    expect(() => s.marshal(null)).toThrow(ProtocolError);
    expect(() => s.unmarshal(Uint8Array.of(0x0a, 0x01, 0x78), { a: 1 })).toThrow(ProtocolError);
  });

  it('未注册 schema：message 合法但 registry 缺失 → ProtocolError', () => {
    const s = new ProtobufSerializer(registry); // 只注册 StringValue
    expect(() => s.marshal(create(TimestampSchema, {}))).toThrow(ProtocolError);
  });
});

describe('@bufbuild DTO 端到端（ver=2 分派，镜像 Go client/ver_test.go）', () => {
  it('ver=2 invoke：请求帧头声明 ver=2，服务端按 ver 解码回 ver=2 帧 → 成功且 DTO 一致', async () => {
    const { dialer } = makeDialer((server) =>
      server.onFrame((header, body) => {
        if (header.type !== 1) return;
        expect(header.version).toBe(VERSION_2); // 服务端侧验证请求帧头声明 ver=2
        const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        expect(new TextDecoder().decode(body.subarray(2, 2 + opLen))).toBe('/test.v1.T/Echo');
        const req = parseStringValue(body.subarray(2 + opLen)); // 服务端按帧头 ver 分派 codec
        // 对称回显：响应沿用与请求相同的 ver（规范 §3.1），data 为 protobuf wire 字节
        server.sendFrame(2, header.seq, buildReplyOK(buildStringValue(`pong-${req}`)), VERSION_2);
      }),
    );
    const c: Client = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithSerializer(new ProtobufSerializer(registry))],
    );
    const respRaw = (await c.invoke(
      '/test.v1.T/Echo',
      create(StringValueSchema, { value: '你好' }),
    )) as Uint8Array;
    // 边界形态：内核 resp=null → 返回 payload 原样字节；调用方按 op 的 output schema 绑定
    const resp = fromBinary(StringValueSchema, respRaw);
    expect(resp.value).toBe('pong-你好');
    await c.close();
  });

  it('ver 不一致（@bufbuild DTO）：服务端违约回 ver=1 → 协议级致命终止（不重连）', async () => {
    const { dialer } = makeDialer((server) =>
      server.onFrame((header, body) => {
        if (header.type !== 1) return;
        const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        void parseStringValue(body.subarray(2 + opLen));
        // 服务端违约：客户端载荷编码 ver=2 却回 ver=1（对齐 Go fakeServer.replyVer
        // 缺省 1 的打样钩子）——失步，协议级致命（校验先于包络解码，payload 无关）。
        server.sendFrame(2, header.seq, buildReplyOK(buildStringValue('x')), VERSION);
      }),
    );
    const c: Client = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithSerializer(new ProtobufSerializer(registry))],
    );
    await expect(c.invoke('/test.v1.T/Echo', create(StringValueSchema, { value: '你好' }))).rejects.toThrow(
      ProtocolError,
    );
    await waitFor(() => c.state() === 'disconnected');
    expect(c.state()).toBe('disconnected'); // 失步连接终止（不重连）
    await c.close();
  });
});
