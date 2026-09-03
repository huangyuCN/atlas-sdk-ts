// golden vectors 对齐测试（规范 §8.1：四语言跑同一组字节用例，防漂移根基）。
// 向量源：atlas-sdk-go/testdata/golden（21 用例，manifest 锁定 atlas 基线 commit）。
// 对拍口径与 atlas-sdk-go/frame/golden_assert_test.go 完全同构：
//   frame  用例走流式读语义（readFrameFrom：incomplete → network、校验失败 → protocol）；
//   reply  用例直读完整包络字节（decodeReply）；
//   status 用例直读 Status 字节（decodeStatus）；
//   期望 JSON 是语言无关形态，逐字段（宽松）对比。
import { describe, expect, it } from 'vitest';
import {
  decodeReply,
  decodeStatus,
  parseRequestBody,
  readFrameFrom,
  type Status,
} from '../src/frame/index.js';
import {
  assertStatusMatches,
  classifyError,
  loadGolden,
  type GoldenCase,
} from './helpers.js';

const golden = loadGolden();

describe('golden vectors 对齐（与 atlas-sdk-go 同源同份）', () => {
  it('向量包完整：21 用例且 manifest 双 sha256 全部校验通过', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(21);
    expect(golden.manifest.protocolVersion).toBe(1);
    expect(golden.manifest.atlasCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(golden.cases.map((c) => [c.id, c] as const))('用例 %s', (_id, c: GoldenCase) => {
    switch (c.kind) {
      case 'frame':
        assertFrameCase(c);
        break;
      case 'reply':
        assertReplyCase(c);
        break;
      case 'status':
        assertStatusCase(c);
        break;
    }
  });
});

/** frame 用例：流式读语义 + body 解析（operation/payload）逐字段对拍。 */
function assertFrameCase(c: GoldenCase): void {
  const res = readFrameFrom(c.input, c.maxBodySize);
  const wantErr = c.expected['error'] ?? '';
  const gotErr = res.ok ? '' : res.reason === 'incomplete' ? 'network' : 'protocol';
  expect(gotErr).toBe(wantErr);
  if (!res.ok) return;

  expect(res.header.type).toBe(c.expected['type']);
  expect(res.header.seq).toBe(c.expected['seq']);
  const { operation, payload } = parseRequestBody(res.body);
  expect(operation).toBe(c.expected['operation']);
  const wantPayload = c.expected['payloadHex'] as string;
  expect(Buffer.from(payload).toString('hex')).toBe(wantPayload);
}

/** reply 用例：响应包络解码对拍（data + hasStatus + Status 宽松对比）。 */
function assertReplyCase(c: GoldenCase): void {
  let data: Uint8Array | undefined;
  let status: Status | null = null;
  let gotErr: string;
  try {
    const reply = decodeReply(c.input);
    data = reply.data;
    status = reply.status;
    gotErr = '';
  } catch (err) {
    gotErr = classifyError(err);
  }
  expect(gotErr).toBe((c.expected['error'] as string | undefined) ?? '');
  if (gotErr !== '') return;

  const hasStatus = c.expected['hasStatus'] as boolean;
  expect(status !== null).toBe(hasStatus);
  const wantData = c.expected['dataHex'] as string | undefined;
  if (wantData !== undefined) {
    expect(Buffer.from(data ?? new Uint8Array()).toString('hex')).toBe(wantData);
  }
  const wantStatus = c.expected['status'] as Record<string, unknown> | undefined;
  if (wantStatus && status) {
    assertStatusMatches(status, wantStatus);
  }
}

/** status 用例：独立 Status 解码对拍。 */
function assertStatusCase(c: GoldenCase): void {
  let status: Status | undefined;
  let gotErr: string;
  try {
    status = decodeStatus(c.input);
    gotErr = '';
  } catch (err) {
    gotErr = classifyError(err);
  }
  expect(gotErr).toBe((c.expected['error'] as string | undefined) ?? '');
  if (gotErr !== '' || status === undefined) return;
  assertStatusMatches(status, c.expected['status'] as Record<string, unknown>);
}
