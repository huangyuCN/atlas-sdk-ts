// 手写 UTF-8 编解码测试（引擎宿主兼容加固）：
// TextEncoder/TextDecoder 是 Web/Node 宿主 API，不是 JS 语言标准——Cocos Creator 等
// 嵌入式 JS 引擎（原生 JSB 环境）不保证提供。协议层自带实现，语义与宿主版对齐：
//   encodeUtf8：lone surrogate（孤立代理项，非法）按宿主 TextEncoder 行为替换为 U+FFFD；
//   decodeUtf8：严格模式（对齐 TextDecoder('utf-8', {fatal: true})），无效序列抛 ProtocolError，
//   开头 BOM（U+FEFF）剥离（宿主默认行为）。
import { describe, expect, it } from 'vitest';
import { decodeUtf8, encodeUtf8 } from '../src/frame/index.js';
import { bytesOf } from './helpers.js';

describe('encodeUtf8', () => {
  it('ASCII 单字节', () => {
    expect(encodeUtf8('ATLS')).toEqual(bytesOf('ATLS'));
    expect(encodeUtf8('')).toEqual(new Uint8Array(0));
  });

  it('中文三字节序列', () => {
    expect(encodeUtf8('玩家不存在')).toEqual(bytesOf('玩家不存在'));
  });

  it('混合多语言与 4 字节字符（emoji）', () => {
    const s = 'op/玩家🎮é';
    expect(decodeUtf8(encodeUtf8(s)).length > 0).toBe(true);
    expect(Array.from(encodeUtf8(s)).length).toBe(new TextEncoder().encode(s).length);
    expect(encodeUtf8(s)).toEqual(new TextEncoder().encode(s));
  });

  it('lone surrogate（孤立代理项）替换为 U+FFFD（对齐宿主 TextEncoder）', () => {
    const got = encodeUtf8('\uD800');
    expect(got).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]));
  });

  it('合法代理对合成 4 字节序列', () => {
    const s = '𝄞'; // U+1D11E（音乐记号，代理对）
    expect(encodeUtf8(s)).toEqual(new TextEncoder().encode(s));
    expect(encodeUtf8(s).length).toBe(4);
  });

  it('长 ASCII 字符串（operation 名典型形态）', () => {
    const s = '/atlas.internal.Heartbeat/Ping';
    expect(encodeUtf8(s)).toEqual(new TextEncoder().encode(s));
  });
});

describe('decodeUtf8（严格模式）', () => {
  it('合法序列往返', () => {
    const s = '帧同步/frame-1🎮';
    expect(decodeUtf8(encodeUtf8(s))).toBe(s);
  });

  it('全 ASCII 快路径', () => {
    expect(decodeUtf8(bytesOf('/gateway.v1.Auth/Login'))).toBe('/gateway.v1.Auth/Login');
  });

  it('开头 BOM 剥离（对齐宿主默认行为）', () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
  });

  it('无效序列抛 ProtocolError', () => {
    // 孤立 continuation byte（0x80 出现在序列首）
    expect(() => decodeUtf8(new Uint8Array([0x80]))).toThrow();
    // 过度编码 0xC0 0x80（禁止形态）
    expect(() => decodeUtf8(new Uint8Array([0xc0, 0x80]))).toThrow();
    // 截断的多字节序列（0xE4 开头缺 continuation）
    expect(() => decodeUtf8(new Uint8Array([0xe4, 0xb8]))).toThrow();
    // 代理对范围的 3 字节编码（ED A0-BF，CESU 禁止形态）
    expect(() => decodeUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow();
    // 超 U+10FFFF（F4 90+ 越界）
    expect(() => decodeUtf8(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))).toThrow();
  });

  it('非 fatal 语义差异说明：严格抛错而非静默替换', () => {
    // 协议层字段（operation/Status bytes）内容损坏按协议错误处理，
    // 不静默替换 U+FFFD——与 TextDecoder(fatal:true) 语义一致。
    expect(() => decodeUtf8(new Uint8Array([0xff, 0x41]))).toThrow();
  });
});
