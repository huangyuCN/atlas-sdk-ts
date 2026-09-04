// 载荷编码 ver 分派集成测试（规范 §3.1 载荷编码协商）：ver 声明推导、ver=2 invoke
// 的帧头声明与响应校验、响应 ver 不一致的协议级致命终止。对齐 atlas-sdk-go/client/
// ver_test.go 的内核语义面——payload 透传序列化器声明 ver=2（DTO 编码与 ver 能力
// 正交）；@bufbuild 真 DTO 编码形态见 test/protobuf.test.ts。
import { describe, expect, it } from 'vitest';
import {
  Kind,
  ProtocolError,
  VERSION,
  VERSION_2,
  WithSerializer,
  encodeUtf8,
  newClient,
  type Client,
  type Serializer,
} from '../src/index.js';
import { buildReplyOK, makeDialer, waitFor } from './helpers.js';
import { serializerVersion, defaultSerializer } from '../src/client/serializer.js';

/** 测试用 ver=2 序列化器：payload 透传 + frame.Versioned 声明（对齐 Go 打样
 * contrib/protobuf 的断言式分工：DTO 编码归实现者，内核只消费版本声明）。 */
class Ver2Serializer implements Serializer {
  readonly name = 'ver2-passthrough';
  readonly version = VERSION_2;
  marshal(req: unknown): Uint8Array {
    if (req === undefined || req === null) return new Uint8Array(0);
    return req as Uint8Array;
  }
  unmarshal(payload: Uint8Array): Uint8Array {
    return payload;
  }
}

/** 手写编码 protobuf StringValue（wrapperspb 同构：field 1 = length-delimited UTF-8）。 */
function pbString(s: string): Uint8Array {
  const v = encodeUtf8(s);
  const out = new Uint8Array(2 + v.length);
  out[0] = 0x0a;
  out[1] = v.length;
  out.set(v, 2);
  return out;
}

/** 手写解析 protobuf StringValue（仅测试用：field 1 长度前缀 UTF-8）。 */
function parsePbString(b: Uint8Array): string {
  expect(b[0]).toBe(0x0a);
  return new TextDecoder().decode(b.subarray(2, 2 + (b[1] ?? 0)));
}

describe('载荷编码 ver 分派（规范 §3.1 载荷编码协商）', () => {
  it('serializerVersion 推导：未实现 Versioned 默认 ver=1，声明者用声明值', () => {
    expect(serializerVersion(defaultSerializer)).toBe(VERSION); // JsonSerializer 未声明 → ver=1
    expect(serializerVersion(new Ver2Serializer())).toBe(VERSION_2); // 声明 ver=2
  });

  it('ver=2 invoke：请求帧头声明 ver=2，服务端按 ver=2 回帧 → 成功且 payload 透传', async () => {
    const { dialer } = makeDialer((server) =>
      server.onFrame((header, body) => {
        if (header.type !== 1) return;
        // 服务端侧验证：请求帧头声明 ver=2（载荷编码协商的帧级自描述）
        expect(header.version).toBe(VERSION_2);
        const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        expect(new TextDecoder().decode(body.subarray(2, 2 + opLen))).toBe('/test.v1.T/Echo');
        const req = parsePbString(body.subarray(2 + opLen));
        // 服务端按请求 ver 分派 codec 解码后回 ver=2 帧（对称回显语义；对齐
        // Go fakeServer.replyVer = Version2 的打样钩子）。
        server.sendFrame(2, header.seq, buildReplyOK(pbString(`pong-${req}`)), VERSION_2);
      }),
    );
    const c: Client = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithSerializer(new Ver2Serializer())],
    );
    const resp = (await c.invoke('/test.v1.T/Echo', pbString('你好'))) as Uint8Array;
    expect(parsePbString(resp)).toBe('pong-你好');
    await c.close();
  });

  it('ver 不一致：服务端违约回 ver=1（客户端 ver=2）→ 协议级致命终止（不重连）', async () => {
    const { dialer } = makeDialer((server) =>
      server.onFrame((header, body) => {
        if (header.type !== 1) return;
        const opLen = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        const req = parsePbString(body.subarray(2 + opLen));
        void req;
        // 服务端违约：客户端载荷编码 ver=2 却回 ver=1（对齐 Go fakeServer.replyVer
        // 缺省 1 的打样钩子）——失步，协议级致命。
        server.sendFrame(2, header.seq, buildReplyOK(pbString('x')), VERSION);
      }),
    );
    const c: Client = await newClient(
      dialer,
      { kind: 'memory', addr: 'mock' },
      Kind.Business,
      [WithSerializer(new Ver2Serializer())],
    );
    await expect(c.invoke('/test.v1.T/Echo', pbString('你好'))).rejects.toThrow(ProtocolError);
    // 失步连接应终止（不重连），状态 disconnected（对齐 Go TestInvokeVersionMismatch
    // 的状态流转等待）。
    await waitFor(() => c.state() === 'disconnected');
    expect(c.state()).toBe('disconnected');
    await c.close();
  });
});

describe('serializerVersion 白名单（评审 Fix）', () => {
  it('非法声明（0/3+/NaN/小数）抛 ProtocolError', () => {
    for (const bad of [0, 3, 99, Number.NaN, 1.5]) {
      const s = { name: 'bad', version: bad } as unknown as Serializer;
      expect(() => serializerVersion(s)).toThrow(ProtocolError);
    }
  });

  it('合法 {1,2} 通过；未声明默认 1', () => {
    expect(serializerVersion({ name: 'v1', version: VERSION } as unknown as Serializer)).toBe(1);
    expect(serializerVersion({ name: 'v2', version: VERSION_2 } as unknown as Serializer)).toBe(2);
    expect(serializerVersion(defaultSerializer)).toBe(1);
  });
});
