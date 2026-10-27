// 依赖边界守卫：游戏域消息（battle / game / matcher）已迁出 SDK，改由游戏自己的协议包
// 按 .proto 生成；SDK 只留传输/会话 + 契约消息（frame / edge / session / common / route /
// lockstep）。
//
// 本用例把这次迁移的**结果**钉死（而不是钉实现）：仓内既不得再有游戏域生成物目录，
// 也不得再 import 它们——手滑把生成物加回来、或新增代码又把游戏域类型引回来，这里即红。
// 判定口径是「文件路径 + import 路径」，与协议包在本地用什么模块名无关。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** REPO_ROOT 本仓根目录（本文件在 test/ 下，取上一级）。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 本文件自身：它按定义会写出被禁路径，扫描时跳过（断言口径不误伤自己）。 */
const SELF = 'test/gameDomainGuard.test.ts';

/** GAME_DOMAIN_DIRS 已迁出的游戏域生成物目录（相对仓根）；存在即说明生成物又回流了。 */
const GAME_DOMAIN_DIRS = ['examples/gen/api/battle', 'examples/gen/api/game', 'examples/gen/api/matcher'];

/** CONTRACT_FILES 仍须存在的契约消息产物（证明删的是游戏域、不是契约面）。 */
const CONTRACT_FILES = [
  'src/gen/api/gateway/v1/opclient/session_pb.ts',
  'src/gen/api/common/v1/opclient/common_pb.ts',
  'examples/gen/api/gateway/v1/session_pb.js',
  'examples/gen/api/common/v1/common_pb.js',
  'examples/gen/api/atlas/v1/route_pb.js',
  'examples/gen/api/lockstep/lockstep_pb.js',
];

/** SKIP_DIRS 不是本仓产物/不受守卫约束的目录：版本库、依赖、构建产物，以及 CI 检出到
 * 工作区内的上游仓（与 gen-dto 门禁同款排除口径），它们的文件不是本仓代码。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'atlas', 'atlas-game-layout']);

/** SCAN_EXTS 参与「import 路径」扫描的文件类型（源码、示例、配置、生成脚本）。 */
const SCAN_EXTS = new Set(['.ts', '.mjs', '.js', '.sh', '.yml', '.json']);

/** walk 递归列出参与扫描的文件（相对仓根，正斜杠）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(REPO_ROOT, dir))) {
    const rel = dir === '' ? name : `${dir}/${name}`;
    const full = join(REPO_ROOT, rel);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(rel, out);
      continue;
    }
    if (SCAN_EXTS.has(extname(name))) out.push(rel);
  }
  return out;
}

/** forbiddenMarkers 是「游戏域依赖」的 import 路径口径：生成物目录、生成物文件名、
 * 已删除的手写包装与游戏协议包（协议包是游戏侧独立版本线，SDK 若依赖它就又把两条
 * 版本线绑回一起了）。 */
const FORBIDDEN_MARKERS = [
  'gen/api/battle',
  'gen/api/game',
  'gen/api/matcher',
  'battle_service_pb',
  'battle_pb',
  'player_service_pb',
  'player_pb',
  'matcher_pb',
  'match_events_pb',
  'src/battle/ops',
  'atlas-game-layout/protocol',
  '@huangyucn/atlas-game-layout',
];

/** scanHits 扫描全仓源码/示例/配置的「游戏域依赖」痕迹（返回 相对路径 → 标记 列表）。 */
function scanHits(): string[] {
  const hits: string[] = [];
  for (const rel of walk('')) {
    if (rel === SELF) continue;
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const marker of FORBIDDEN_MARKERS) {
      if (text.includes(marker)) hits.push(`${rel} → ${marker}`);
    }
  }
  return hits;
}

describe('依赖边界：游戏域消息已迁出 SDK', () => {
  it('仓内不存在游戏域生成物目录，契约消息产物仍在', () => {
    for (const dir of GAME_DOMAIN_DIRS) {
      expect(existsSync(join(REPO_ROOT, dir)), `游戏域生成物目录仍在：${dir}`).toBe(false);
    }
    for (const file of CONTRACT_FILES) {
      expect(existsSync(join(REPO_ROOT, file)), `契约消息产物缺失：${file}`).toBe(true);
    }
  });

  it('仓内没有 .ts/.mjs/.js/.sh/.yml/.json 引用游戏域生成物或游戏协议包', () => {
    expect(scanHits()).toEqual([]);
  });

  it('手写战斗 op 集合已删除，公共导出口不再导出它', () => {
    expect(existsSync(join(REPO_ROOT, 'src/battle/ops.ts')), 'src/battle/ops.ts 应已删除').toBe(false);
    const index = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');
    for (const name of ['BattleOps', 'BattlePushOps', 'DEFAULT_BATTLE_OPS', 'BattleOpSet']) {
      expect(index.includes(name), `src/index.ts 仍在导出 ${name}`).toBe(false);
    }
  });

  it('生成脚本不再生成游戏域（否则门禁会把生成物再生成回来）', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts/gen-dto.sh'), 'utf8');
    for (const proto of [
      'battle_service.proto',
      'battle.proto',
      'player_service.proto',
      'player.proto',
      'matcher.proto',
      'match_events.proto',
    ]) {
      expect(script.includes(proto), `gen-dto.sh 仍引用游戏域 proto：${proto}`).toBe(false);
    }
  });

  it('package.json 不依赖游戏协议包（两条版本线解耦）', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    expect(names.filter((n) => n.includes('atlas-game-layout'))).toEqual([]);
  });
});
