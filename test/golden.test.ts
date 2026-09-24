// golden vectors 对齐测试（规范 §8.1：四语言跑同一组字节用例，防漂移根基）。
// 向量源：atlas 主仓 testdata/golden（manifest 锁定 atlas 基线 commit；用例数
// 以 manifest 为准，逐用例自动消费，新增用例无需改本文件）。
// 对拍口径与 atlas-sdk-go/frame/golden_assert_test.go 完全同构：
//   frame  用例走流式读语义（readFrameFrom：incomplete → network、校验失败 → protocol）；
//   reply  用例直读完整包络字节（decodeReply）；
//   status 用例直读 Status 字节（decodeStatus）；
//   期望 JSON 是语言无关形态，逐字段（宽松）对比。
import { describe, expect, it } from 'vitest';
import {
  VERSION_2,
  decodeReply,
  decodeStatus,
  parseRequestBody,
  readFrameFrom,
  type Status,
} from '../src/frame/index.js';
import { SessionProtocolOps, type LoginRequest } from '../src/gen/api/gateway/v1/opclient/session_pb.js';
import {
  assertStatusMatches,
  classifyError,
  loadGolden,
  type GoldenCase,
} from './helpers.js';

const golden = loadGolden();

/** caseById 取指定 id 的用例（缺失即抛错——用例改名/删除必须显式处理）。 */
function caseById(id: string): GoldenCase {
  const c = golden.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden 用例缺失：${id}`);
  return c;
}

describe('golden vectors 对齐（与 atlas 主仓同源同份，四语言同一向量）', () => {
  it('向量包完整：用例数 ≥ 21 且 manifest 双 sha256 全部校验通过', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(21); // 新增用例以 manifest 为准动态消费
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

// golden 新 kind/字段的语义断言（P4 扩展：会话 op / ver=2 载荷 / 错误投影 class）。
// 字节对拍在通用用例里已覆盖，这里锁定「字节 → 语义」的映射与生成物一致。
describe('golden 新 kind 语义（P4：会话 op / ver=2 载荷 / 错误投影 class）', () => {
  it('会话 op 用例：operation 与模板生成的会话 stub 同名同值，载荷字段名与生成 DTO 一致', () => {
    const c = caseById('frame-request-session-login');
    const res = readFrameFrom(c.input, c.maxBodySize);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { operation, payload } = parseRequestBody(res.body);
    // op 唯一来源是接缝/生成物：golden 里的客户端 op 必须等于生成的会话 op
    expect(operation).toBe(SessionProtocolOps.login);
    // 载荷按生成 DTO 类型解（字段名 lowerCamelCase 由生成物钉住，编译期即校验）
    const req = JSON.parse(new TextDecoder().decode(payload)) as LoginRequest;
    expect(req.playerId).toBe('p1');
    expect(req.password).toBe('x');
  });

  it('ver=2 用例：帧头声明 ver=2，载荷是 protobuf 字节（非 protojson）', () => {
    const c = caseById('frame-request-ver2');
    const res = readFrameFrom(c.input, c.maxBodySize);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 载荷编码协商：ver=2 = protobuf 二进制（生成常量 VERSION2 的 SDK 别名）
    expect(res.header.version).toBe(VERSION_2);
    const { payload } = parseRequestBody(res.body);
    expect(Buffer.from(payload).toString('hex')).toBe(c.expected['payloadHex']);
    // protobuf 字节不是 protojson：按文本解 JSON 必然失败（区分 ver=1/ver=2 语义）
    expect(() => JSON.parse(new TextDecoder().decode(payload))).toThrow();
  });

  it('错误投影：Status.class 解出并投影（reply/status 两类用例）', () => {
    const full = caseById('status-full');
    const status = decodeStatus(full.input);
    expect(status.class).toBe(2);
    expect(status.reason).toBe('PLAYER_NOT_FOUND');

    const reply = caseById('reply-error-status');
    const decoded = decodeReply(reply.input);
    expect(decoded.status?.class).toBe(2);
    expect(decoded.status?.code).toBe(404);
  });
});
