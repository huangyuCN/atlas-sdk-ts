#!/usr/bin/env bash
# gen-dto：从上游生成物刷新本仓的全部「协议事实」，单一来源、零手写副本。
#
# 输入（只读消费，不在本仓生成协议）：
#   - 框架仓 frame 常量生成物：$ATLAS_DIR/transport/frame/gen/ts/frame.ts
#   - 模板仓会话协议 descriptor set：$ATLAS_LAYOUT_DIR/api/gateway/v1/session.proto
#     （含 battle 域：examples 的 ver=2 protobuf 冒烟需要权威 DTO）
# 输出（全部入库，CI 有「重生成无 diff」门禁）：
#   1. src/frame/gen/frame.ts                              帧协议常量快照（逐字节复制）
#   2. src/gen/api/gateway/v1/opclient/session_pb.ts       会话 stub 快照（零运行时 DTO + op 名 + 提取器）
#      src/gen/api/common/v1/opclient/common_pb.ts         会话 stub 的跨包依赖（PlayerSummary）
#   3. examples/gen/api/**                                 冒烟用 @bufbuild schema（protoc-gen-es，ver=2 编码用）
#
# 环境变量（默认同级相对路径；CI 用 workspace 绝对路径显式指定）：
#   ATLAS_DIR         框架仓根（默认同级 ../atlas），提供帧生成物与 session.proto 的 route 依赖
#   ATLAS_LAYOUT_DIR  模板仓根（默认同级 ../atlas-game-layout），会话协议唯一来源
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"
ATLAS_DIR="${ATLAS_DIR:-$(cd .. && pwd)/atlas}"
ATLAS_LAYOUT_DIR="${ATLAS_LAYOUT_DIR:-$(cd .. && pwd)/atlas-game-layout}"

for d in "$ATLAS_DIR" "$ATLAS_LAYOUT_DIR"; do
  if [ ! -d "$d" ]; then
    echo "gen-dto: 上游仓不存在：$d（用 ATLAS_DIR / ATLAS_LAYOUT_DIR 指定）" >&2
    exit 1
  fi
done

# 1) 帧协议常量：框架生成物逐字节复制到仓内固定路径（SDK 侧 constants.ts 只做转发）。
mkdir -p src/frame/gen
cp "$ATLAS_DIR/transport/frame/gen/ts/frame.ts" src/frame/gen/frame.ts
echo "帧协议常量 → src/frame/gen/frame.ts"

# 2) 会话协议 descriptor set：模板仓导出（session.proto 导入框架仓的 atlas route 注解，
#    故必须同时给两个 include 根）。
DESC="$(mktemp -t atlas-gateway-desc.XXXXXX)"
trap 'rm -f "$DESC"' EXIT
protoc --descriptor_set_out="$DESC" --include_imports \
  -I "$ATLAS_LAYOUT_DIR" -I "$ATLAS_DIR" \
  "$ATLAS_LAYOUT_DIR/api/gateway/v1/session.proto" \
  "$ATLAS_LAYOUT_DIR/api/battle/v1/battle_service.proto"
echo "descriptor set → ${DESC}（模板仓导出）"

# 3) 会话 stub 快照：protoc-gen-atlas-client 的 TS 产物，镜像模板仓目录布局
#    （跨包相对 import 原样成立，只改写 SDK 自引用；形态校验见 vendor-session-stub.mjs）。
rm -rf src/gen
mkdir -p src/gen
node scripts/vendor-session-stub.mjs \
  "$ATLAS_LAYOUT_DIR/api/client/ts/api/gateway/v1/opclient/session_pb.ts" \
  "$ATLAS_LAYOUT_DIR/api/client/ts/api/common/v1/opclient/common_pb.ts" \
  "$ATLAS_LAYOUT_DIR/api/client/ts" src/gen "$ATLAS_LAYOUT_DIR"

# 4) 冒烟用 schema：以 descriptor set 为输入跑 protoc-gen-es（不 vendored .proto），
#    产出 ES module + d.ts（examples/*.mjs 直接 node 运行）。列出的文件是
#    examples 需要的 DTO 及其 import 闭包（未列出的依赖不生成）。
rm -rf examples/gen
mkdir -p examples/gen
protoc --descriptor_set_in="$DESC" \
  --plugin=protoc-gen-es=./node_modules/.bin/protoc-gen-es \
  --es_out=examples/gen --es_opt=import_extension=js \
  api/gateway/v1/session.proto \
  api/common/v1/common.proto \
  api/atlas/v1/route.proto \
  api/battle/v1/battle_service.proto \
  api/battle/v1/battle.proto \
  api/lockstep/lockstep.proto
echo "冒烟 schema → examples/gen/api/**"

# 改动计数排除 CI 检出的上游目录（它们不是本仓产物，见 workflow 门禁同款 pathspec）。
echo "生成完成（重跑本脚本应无 diff；当前工作区改动：$(git -C "$REPO_ROOT" status --porcelain -- . ':!atlas' ':!atlas-game-layout' | wc -l | tr -d ' ') 处）"
