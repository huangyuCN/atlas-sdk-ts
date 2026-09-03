// 错误四分类与序列化器测试。
import { describe, expect, it } from 'vitest';
import {
  AtlasError,
  BusinessError,
  NetworkError,
  ProtocolError,
  TimeoutError,
  isBusinessError,
  isProtocolError,
} from '../src/client/errors.js';
import { ProtocolError as FrameProtocolError } from '../src/frame/protocolError.js';
import { JsonSerializer, defaultSerializer } from '../src/client/serializer.js';

describe('错误四分类', () => {
  it('四类均继承 AtlasError 且 name="AtlasError"', () => {
    const errs = [
      new BusinessError(404, 'PLAYER_NOT_FOUND', '玩家不存在'),
      new NetworkError('连接已关闭'),
      new TimeoutError('/op', 1000),
      new ProtocolError('包络非法'),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(AtlasError);
      expect(e.name).toBe('AtlasError');
    }
  });

  it('BusinessError 携带 Code/Reason/Message/Metadata', () => {
    const e = new BusinessError(404, 'PLAYER_NOT_FOUND', '玩家不存在', { k: 'v' });
    expect(e.code).toBe(404);
    expect(e.reason).toBe('PLAYER_NOT_FOUND');
    expect(e.messageText).toBe('玩家不存在');
    expect(e.metadata).toEqual({ k: 'v' });
  });

  it('cause 为手动赋值属性（不依赖 ES2022 语言内置）', () => {
    const cause = new Error('底层错误');
    const e = new NetworkError('写失败', cause);
    expect(e.cause).toBe(cause);
    expect(Object.getOwnPropertyDescriptor(e, 'cause')?.writable).toBe(true);
  });

  it('内核 ProtocolError 与协议层哨兵独立，cause 链指向原始协议层错误', () => {
    const frameErr = new FrameProtocolError('帧非法');
    const e = new ProtocolError('包络非法', frameErr);
    expect(e).toBeInstanceOf(AtlasError);
    expect(e).not.toBeInstanceOf(FrameProtocolError); // 依赖方向：frame 不依赖 client
    expect(e.cause).toBe(frameErr);
    expect(isProtocolError(e)).toBe(true);
    expect(isProtocolError(new NetworkError('x'))).toBe(false);
  });

  it('isProtocolError 同时识别帧层 ProtocolError（评审 Fix：用户直接调 decodeFrame 抛的帧层错误）', () => {
    expect(isProtocolError(new FrameProtocolError('帧非法'))).toBe(true);
  });

  it('isBusinessError 按 Reason 精确匹配（不比对 Code/Metadata）', () => {
    const e = new BusinessError(404, 'PLAYER_NOT_FOUND', 'x');
    expect(isBusinessError(e, 'PLAYER_NOT_FOUND')).toBe(true);
    expect(isBusinessError(e, 'OTHER')).toBe(false);
    expect(isBusinessError(e)).toBe(true);
    expect(isBusinessError(new NetworkError('x'), 'PLAYER_NOT_FOUND')).toBe(false);
  });

  it('TimeoutError 携带 operation', () => {
    const e = new TimeoutError('/battle.v1.Battle/OnFrame', 1000);
    expect(e.operation).toBe('/battle.v1.Battle/OnFrame');
  });
});

describe('JsonSerializer', () => {
  it('marshal：对象 → JSON 字节；null/undefined → 空字节', () => {
    expect(new TextDecoder().decode(defaultSerializer.marshal({ a: 1 }))).toBe('{"a":1}');
    expect(defaultSerializer.marshal(null).length).toBe(0);
    expect(defaultSerializer.marshal(undefined).length).toBe(0);
  });

  it('unmarshal：填充目标对象（resp 非 null）', () => {
    const target = { playerId: '' };
    defaultSerializer.unmarshal(new TextEncoder().encode('{"playerId":"p1"}'), target);
    expect(target.playerId).toBe('p1');
  });

  it('unmarshal：resp 为 null 时返回解码值', () => {
    const v = defaultSerializer.unmarshal(new TextEncoder().encode('[1,2]'), null);
    expect(v).toEqual([1, 2]);
  });

  it('unmarshal：空 payload 原样返回 resp（零值响应）', () => {
    const target = { scores: 0 };
    expect(defaultSerializer.unmarshal(new Uint8Array(0), target)).toBe(target);
  });

  it('marshal 循环引用抛 ProtocolError（对齐 Go：序列化失败归协议错误）', () => {
    const o: Record<string, unknown> = {};
    o['self'] = o;
    expect(() => new JsonSerializer().marshal(o)).toThrow(ProtocolError);
  });

  it('unmarshal 非法 JSON 抛 ProtocolError', () => {
    expect(() => defaultSerializer.unmarshal(new TextEncoder().encode('{bad'), null)).toThrow(
      ProtocolError,
    );
  });
});
