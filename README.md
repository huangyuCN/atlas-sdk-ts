# atlas-sdk-ts

Atlas 多语言客户端 SDK 的 **TypeScript 实现**：面向游戏客户端的帧协议接入层，
浏览器（WebGL/Web）与 Node 双目标，产物 **ESM + CJS + d.ts** 三形态。

- 协议规范（唯一事实源）：atlas 主仓
  `docs/superpowers/specs/2026-08-28-client-sdk-multilang-design.md`
- 协议基线：atlas `feat/actor` 分支顶点 `40d8e74`（当前与 main 同顶点；golden manifest
  `atlasCommit` 字段锁定，见下「golden vectors」）
- 路线与实施状态：[docs/roadmap.md](docs/roadmap.md)

## 安装

npm 包名待定（规范 §10 待定项，见 roadmap）；当前可用 git 依赖或本地构建使用：

```bash
git clone https://github.com/huangyuCN/atlas-sdk-ts
pnpm install && pnpm build   # 产物在 dist/（index.js ESM / index.cjs CJS / index.d.ts）
```

## 使用（协议层，v0.1）

帧编解码 / 响应包络 / 业务错误 Status 还原，与服务端四通道帧协议逐字节一致
（golden vectors 21 用例对拍防漂移）：

```ts
import {
  buildRequestBody, decodeReply, decodeStatus, decodeFrame,
  encodeFrame, MsgType, type Header,
} from '@huangyucn/atlas-sdk-ts';

// 请求帧：[opLen:u16][operation][payload]（payload 为 protojson 形态 JSON 字节）
const body = buildRequestBody('/gateway.v1.Auth/Login', loginJson);
const frame = encodeFrame(
  { magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 } as Header,
  body,
);

// 响应包络：成功 [0][dataLen][data]；失败 [1][statusLen][Status protobuf][dataLen][data]
const reply = decodeReply(respBody);
if (reply.status) {
  // 业务拒绝：按 Reason 分支（规范 §7.1；Reason 常量由 atlas sdk gen --lang ts 生成）
  if (reply.status.reason === 'PLAYER_NOT_FOUND') { /* ... */ }
} else {
  const dto = JSON.parse(new TextDecoder().decode(reply.data));
}

// 服务端推送（Notify）：一条 WS 消息 = 一个完整帧
const { header, body: notifyBody } = decodeFrame(wsMessage);
```

## 运行时内核与通道（roadmap v0.2/v0.3 交付）

内核（Invoke `(epoch, seq)` 匹配、Notify 订阅、双层心跳、指数退避重连、dual 双通道编排）
与通道（浏览器 WebSocket 优先 → Node TCP/UDP）按 roadmap 推进；协议层字节格式
已由本批次锁定，内核/通道语义遵循规范 §5 并与 atlas-sdk-go 的实施语义逐条同源。

## 引擎宿主（Cocos Creator 等）

协议层与后续内核为**零宿主依赖**（仅 JS 语言标准能力），可直接在 Cocos Creator 等
嵌入式 JS 引擎（原生 JSB 环境）中使用：

- UTF-8 走协议层自带手写实现（不依赖宿主 `TextEncoder`/`TextDecoder`）；
- 产物 target ES2020；错误 `cause` 手动赋值（不依赖 ES2022 语言内置）；
- 通道层在引擎宿主仅 WebSocket 可用（Web 构建用浏览器原生 WS、原生构建用引擎 JSB
  绑定）——single 形态；TCP/UDP/KCP 不可用（约定见规范 §4「引擎宿主兼容性约定」）。

## DTO

**不手写 DTO**：由 atlas CLI 生成器产出（规范 §6.4）——

```bash
atlas sdk gen --lang ts --protoset <protoc --descriptor_set_out 产物> --out dto
```

产物按 proto 包分目录（如 `gateway/v1/`、`battle/v1/`），TS 相对导入天然无冲突。

## golden vectors（协议一致性根基）

规范 §8.1：四语言消费**同一份向量**（atlas-sdk-go 仓 `testdata/golden/`，21 用例，
manifest 双 sha256 逐文件校验、锁定 atlas 基线 commit）。本仓测试直接消费该目录：

- 默认路径：与本仓**同级**的 `../atlas-sdk-go/testdata/golden`；
- 环境变量 `ATLAS_GOLDEN_DIR` 可覆盖（CI 中由 checkout 位置决定）；
- 向量源仓在 CI 中 pin 到固定 commit（见 `.github/workflows/ci.yml` 与 roadmap）。

## 开发命令

```bash
pnpm install        # 安装依赖（pnpm ≥ 10；esbuild 构建脚本已放行，见 pnpm-workspace.yaml）
pnpm test           # 单测 + golden 对齐（vitest）
pnpm typecheck      # tsc --noEmit（strict + noUncheckedIndexedAccess）
pnpm check          # typecheck + test
pnpm build          # tsup → dist/（ESM + CJS + d.ts 三形态）
```

## 目录速览

```
src/frame/        协议层：帧编解码 / 包络 / Status / body（零平台依赖，双目标共用）
test/             单测 + golden 对齐（向量源 atlas-sdk-go/testdata/golden）
docs/roadmap.md   路线与实施状态
```

## 开发约定

- **规范先行**：新增/变更线格式先改 atlas 规范 + golden vectors，四语言实现跟进；
- **中文注释/提交说明**；TDD 测试先行；单文件 ≤ 500 行、单函数 ≤ 50 行；
- **协议层/内核零平台依赖**（仅 Uint8Array/BigInt 等 JS 语言标准能力；UTF-8 手写实现
  不依赖宿主 TextEncoder/TextDecoder，见 `src/frame/utf8.ts`），平台差异收敛在传输层
  （浏览器 WebSocket / Node net·dgram）。
