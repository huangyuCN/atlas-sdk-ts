// 测试工具：golden 向量加载 + 字节构造辅助（与 atlas-sdk-go/frame/golden_test.go 的
// 构造方式对称，保证同一份向量两侧可复现）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { ProtocolError, type Status } from '../src/frame/index.js';

/** golden 向量目录：默认 ../atlas-sdk-go/testdata/golden（与本仓同级的 Go SDK 仓——
 * 规范 §8.1 四语言消费同一份向量；manifest 锁定 atlas 基线 commit）。
 * 可用环境变量 ATLAS_GOLDEN_DIR 覆盖（CI 中由 checkout 位置决定）。 */
export function goldenDir(): string {
  const env = process.env['ATLAS_GOLDEN_DIR'];
  if (env) return env;
  const here = fileURLToPath(new URL('.', import.meta.url)); // 本仓 test/ 目录
  return resolve(here, '../../atlas-sdk-go/testdata/golden');
}

/** manifest 逐用例元数据（kind / max_body_size / 双 sha256）。 */
export interface CaseMeta {
  sha256_input: string;
  sha256_expected: string;
  kind: 'frame' | 'reply' | 'status';
  max_body_size: number;
}

export interface GoldenManifest {
  atlasCommit: string;
  atlasRef: string;
  atlasRepo: string;
  cases: Record<string, CaseMeta>;
  note: string;
  protocolVersion: number;
}

export interface GoldenCase {
  id: string;
  kind: CaseMeta['kind'];
  maxBodySize: number;
  input: Uint8Array;
  expected: Record<string, unknown>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 加载全量 golden 向量并做 manifest 双 sha256 校验（任一不匹配即抛错）。 */
export function loadGolden(): { dir: string; manifest: GoldenManifest; cases: GoldenCase[] } {
  const dir = goldenDir();
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as GoldenManifest;
  const cases: GoldenCase[] = [];
  for (const [id, meta] of Object.entries(manifest.cases)) {
    const input = new Uint8Array(readFileSync(join(dir, 'cases', id, 'input.bin')));
    const expectedRaw = readFileSync(join(dir, 'cases', id, 'expected.json'));
    const gotInput = sha256Hex(input);
    if (gotInput !== meta.sha256_input) {
      throw new Error(`${id}/input.bin sha256 不匹配: ${gotInput} != ${meta.sha256_input}`);
    }
    const gotExpected = sha256Hex(new Uint8Array(expectedRaw));
    if (gotExpected !== meta.sha256_expected) {
      throw new Error(`${id}/expected.json sha256 不匹配: ${gotExpected} != ${meta.sha256_expected}`);
    }
    cases.push({
      id,
      kind: meta.kind,
      maxBodySize: meta.max_body_size,
      input,
      expected: JSON.parse(expectedRaw.toString('utf8')) as Record<string, unknown>,
    });
  }
  return { dir, manifest, cases };
}

/** 错误分类对拍口径（与 Go classifyError 同构）：协议非法 → "protocol"，其余 → "network"。 */
export function classifyError(err: unknown): 'protocol' | 'network' {
  return err instanceof ProtocolError ? 'protocol' : 'network';
}

// ---- 字节构造辅助（与 Go golden_test.go 同名函数对称） ----

export function putU16BE(b: Uint8Array, v: number): void {
  b[0] = v >> 8;
  b[1] = v;
}

export function putU32BE(b: Uint8Array, v: number): void {
  b[0] = v >>> 24;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 构造完整帧字节（MAGIC/VERSION/合法 type 语义，seq 显式给定）。 */
export function concatFrame(type: number, seq: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + body.length);
  putU32BE(out.subarray(0, 4), 0x41544c53);
  out[4] = 1;
  out[5] = type;
  putU32BE(out.subarray(8, 12), seq);
  putU32BE(out.subarray(12, 16), body.length);
  out.set(body, 16);
  return out;
}

/** 构造成功响应包络：[hasError=0][dataLen][data]。 */
export function buildReplyOK(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = 0;
  putU32BE(out.subarray(1, 5), data.length);
  out.set(data, 5);
  return out;
}

/** 构造失败响应包络：[hasError=1][statusLen][status][dataLen][data]。 */
export function buildReplyErr(status: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 4 + status.length + 4 + data.length);
  out[0] = 1;
  putU32BE(out.subarray(1, 5), status.length);
  out.set(status, 5);
  const off = 5 + status.length;
  putU32BE(out.subarray(off, off + 4), data.length);
  out.set(data, off + 4);
  return out;
}

/** varint 编码（无符号，LEB128，最多 10 字节）。 */
export function encodeUvarint(v: bigint): Uint8Array {
  const out: number[] = [];
  let x = v;
  for (;;) {
    const byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x === 0n) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return Uint8Array.from(out);
}

/** 追加一个 varint 字段（tag = fieldNum<<3|0）。 */
export function appendVarintField(dst: number[], fieldNum: number, v: bigint): void {
  dst.push((fieldNum << 3) | 0);
  dst.push(...encodeUvarint(v));
}

/** 追加一个 length-delimited 字段（tag = fieldNum<<3|2）。 */
export function appendBytesField(dst: number[], fieldNum: number, value: Uint8Array): void {
  dst.push((fieldNum << 3) | 2);
  dst.push(...encodeUvarint(BigInt(value.length)));
  dst.push(...value);
}

/** 手写编码 Status protobuf（字段号 1/2/3/4，与 atlas errors/errors.proto 对齐）。 */
export function buildTestStatus(
  code: number,
  reason: string,
  message: string,
  metadata: Record<string, string> | null,
): Uint8Array {
  const out: number[] = [];
  if (code !== 0) {
    // int32 负值按 protobuf 有符号语义编码为 uint64 补码（如 -1 → 0xFFFFFFFFFFFFFFFF）。
    appendVarintField(out, 1, BigInt.asUintN(64, BigInt(code)));
  }
  if (reason !== '') appendBytesField(out, 2, bytesOf(reason));
  if (message !== '') appendBytesField(out, 3, bytesOf(message));
  if (metadata) {
    for (const [k, v] of Object.entries(metadata)) {
      const entry: number[] = [];
      appendBytesField(entry, 1, bytesOf(k));
      appendBytesField(entry, 2, bytesOf(v));
      appendBytesField(out, 4, Uint8Array.from(entry));
    }
  }
  return Uint8Array.from(out);
}

/** Status 宽松对比（与 Go assertStatusJSON 同口径：只比期望中出现的字段）。 */
export function assertStatusMatches(actual: Status, want: Record<string, unknown>): void {
  const code = want['code'];
  if (typeof code === 'number') expect(actual.code).toBe(code);
  const reason = want['reason'];
  if (typeof reason === 'string') expect(actual.reason).toBe(reason);
  const message = want['message'];
  if (typeof message === 'string') expect(actual.message).toBe(message);
  const meta = want['metadata'];
  if (meta !== null && meta !== undefined && typeof meta === 'object') {
    const entries = Object.entries(meta as Record<string, unknown>);
    expect(Object.keys(actual.metadata ?? {}).length).toBe(entries.length);
    for (const [k, v] of entries) {
      expect(actual.metadata?.[k]).toBe(v);
    }
  }
}
