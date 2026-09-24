// vendor-session-stub：把模板仓生成的 TS 会话 stub（protoc-gen-atlas-client 产物）
// 快照进本仓固定路径，供接缝契约测试与 Session 的请求/回执 DTO 消费。
//
// 快照**镜像模板仓的目录布局**（`<模板 TS 根>/api/gateway/v1/opclient/session_pb.ts`
// → `<本仓输出根>/api/gateway/v1/opclient/session_pb.ts`），因此生成物内部的跨包相对
// import（如 `../../../common/v1/opclient/common_pb.js`）在快照里原样成立，不做改写。
//
// 唯一改写：SDK 自引用。生成物按「本 SDK 的使用方」写 npm 包名
// '@huangyucn/atlas-sdk-ts'，而本仓自身在 CI 里未构建 dist（自引用不可解析），
// 故改为仓内相对路径（从快照文件位置算到 src/client/）。
//
// 其余为**形态校验**：上游生成器的 import 形态或接缝素材符号变了就显式失败——
// 宁可让门禁红，也不静默产出坏快照。
//
// 用法：node scripts/vendor-session-stub.mjs <session_pb.ts> <common_pb.ts> <模板 TS 根> <输出根> <模板仓根>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const [sessionSrc, commonSrc, layoutTSRoot, outRoot, layoutRoot] = process.argv.slice(2);
if (!sessionSrc || !commonSrc || !layoutTSRoot || !outRoot || !layoutRoot) {
  console.error(
    '用法：node scripts/vendor-session-stub.mjs <session_pb.ts> <common_pb.ts> <模板 TS 根> <输出根> <模板仓根>',
  );
  process.exit(2);
}

/** outPathOf 按模板仓 TS 根的相对位置算出快照落点（镜像布局）。 */
function outPathOf(layoutFile) {
  return join(outRoot, relative(layoutTSRoot, layoutFile));
}

/** sourceLabel 返回稳定的上游标识（模板仓目录名 + 仓内相对路径；不写绝对路径，
 * 否则 CI 与本机 checkout 路径不同会让「重生成无 diff」门禁必然失败）。 */
function sourceLabel(layoutFile) {
  return join(basename(resolve(layoutRoot)), relative(resolve(layoutRoot), layoutFile));
}

/** snapshotHeader 生成快照文件头（标明来源与已做的处理，避免被误当手写代码）。 */
function snapshotHeader(source, note) {
  return (
    [
      '// ⚠️ 本文件是模板仓生成物的快照（由 scripts/gen-dto.sh 产出，勿手改）。',
      `// source: ${source}`,
      `// 快照处理：${note}`,
      '// 上游重新生成后请重跑 scripts/gen-dto.sh（CI 有「重生成无 diff」门禁）。',
    ].join('\n') + '\n'
  );
}

/** expectAll 断言文本包含全部片段；任一缺失即失败（上游形态变化必须显式处理）。 */
function expectAll(text, file, needles) {
  for (const n of needles) {
    if (!text.includes(n)) {
      throw new Error(`${file}: 缺少期望片段 ${JSON.stringify(n)}（上游生成器形态已变化？）`);
    }
  }
}

/** replaceOnce 精确替换唯一片段（出现次数 ≠ 1 即失败）。 */
function replaceOnce(text, file, from, to) {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: 期望出现 1 次的片段实际出现 ${count} 次：${JSON.stringify(from)}`);
  }
  return text.replace(from, to);
}

/** sdkRel 计算从快照文件到 <仓>/src/<相对路径> 的相对 import（必须以 .. 开头）。 */
function sdkRel(outFile, srcRelative) {
  const srcRoot = dirname(resolve(outRoot)); // 输出根为 <仓>/src/gen → srcRoot = <仓>/src
  const rel = relative(dirname(resolve(outFile)), join(srcRoot, srcRelative));
  if (!rel.startsWith('..')) {
    throw new Error(`快照落点 ${outFile} 与 ${srcRelative} 的相对路径异常：${rel}`);
  }
  return rel.split('\\').join('/');
}

// ---- 会话 stub：形态校验 + SDK 自引用改写 ----
const sessionOut = outPathOf(sessionSrc);
const sdkImportFrom = "import type { Invoker, InvokeOption } from '@huangyucn/atlas-sdk-ts';";
const sdkImportTo = [
  `import type { Invoker } from '${sdkRel(sessionOut, 'client/invoker.js')}';`,
  `import type { InvokeOption } from '${sdkRel(sessionOut, 'client/options.js')}';`,
].join('\n');

let sessionText = readFileSync(sessionSrc, 'utf8');
expectAll(sessionText, 'session_pb.ts', [
  // 跨包 DTO 的相对 import 按「产物目录（含 opclient）起算」——生成器修复后的形态
  'import type { PlayerSummary } from "../../../common/v1/opclient/common_pb.js";',
  sdkImportFrom,
  // 接缝素材（S0.5）：5 个 op + 3 个解码钩子 + 推送 op
  'export const SessionProtocolOps',
  'export function sessionToken',
  'export function sessionPlayerID',
  'export function sessionExpiresAt',
  'export const sessionPushOps',
  // Session 消费的 DTO（请求/回执/推送）
  'export interface LoginRequest',
  'export interface LoginReply',
  'export interface ResumeRequest',
  'export interface ResumeReply',
  'export interface RegisterRequest',
  'export interface RegisterReply',
  'export interface HeartbeatReply',
  'export interface LogoutRequest',
  'export interface KickedNotify',
]);
sessionText = replaceOnce(sessionText, 'session_pb.ts', sdkImportFrom, sdkImportTo);

// ---- 跨包 DTO 快照（布局镜像后其相对 import 原样成立，无需改写） ----
const commonOut = outPathOf(commonSrc);
const commonText = readFileSync(commonSrc, 'utf8');
expectAll(commonText, 'common_pb.ts', ['export interface PlayerSummary']);
if (/^import\b/m.test(commonText)) {
  throw new Error('common_pb.ts: 纯 DTO 快照不应出现 import（上游新增了跨文件引用？）');
}

const snapshots = [
  [
    sessionOut,
    sourceLabel(sessionSrc),
    sessionText,
    '布局镜像（跨包相对 import 原样成立）；仅 SDK 自引用的 npm 包名改为仓内相对路径',
  ],
  [commonOut, sourceLabel(commonSrc), commonText, '布局镜像（纯 DTO，无 import）'],
];
for (const [file, source, text, note] of snapshots) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, snapshotHeader(source, note) + text);
}

console.log(`会话 stub 快照完成 → ${sessionOut}、${commonOut}`);
