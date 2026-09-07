#!/usr/bin/env bash
# 生成 gatewayv1 protobuf DTO（protoc-gen-es）——smoke 冒烟用 schema 单源：
# examples/proto/gatewayv1/auth.proto → examples/proto/gen/gatewayv1/auth_pb.{js,d.ts}
# 统一官方栈（三库对齐路线 B）：不再手写 descriptor，schema 一律生成。
# 产物已提交入库（对齐 Go 侧 pb.go 提交惯例）；proto 改动后重跑本脚本。
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p examples/proto/gen
protoc \
  --plugin=protoc-gen-es=./node_modules/.bin/protoc-gen-es \
  --es_out=examples/proto/gen \
  --proto_path=examples/proto \
  examples/proto/gatewayv1/auth.proto

echo "生成完成 → examples/proto/gen/gatewayv1/auth_pb.{js,d.ts}"
