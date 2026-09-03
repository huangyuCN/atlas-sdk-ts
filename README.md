# atlas-sdk-ts

[![CI](https://github.com/huangyuCN/atlas-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/huangyuCN/atlas-sdk-ts/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Atlas 帧协议的 TypeScript 客户端 SDK。浏览器与 Node 双目标（产物同时提供
ESM / CJS / d.ts 三种形态），面向游戏客户端、机器人与工具脚本连接
[Atlas](https://github.com/huangyuCN/atlas) 游戏服务端。

> **当前状态**：协议层 + 运行时内核（请求匹配、推送订阅、双层心跳、断线重连、
> dual 双通道编排）已可用；通道传输（WebSocket / TCP / UDP 真实连接）开发中，
> 见 [roadmap](docs/roadmap.md)。

## 特性

- **协议层开箱即用**：帧编解码（`encodeFrame` / `decodeFrame` / `readFrameFrom`）、
  请求-响应包络解析（`decodeReply`）、业务错误还原（`decodeStatus`）——与服务端
  四通道帧协议逐字节一致。
- **流式与消息边界两种形态**：TCP/KCP 字节流的粘包切分（`readFrameFrom`，
  未完整返回 `incomplete`、非法返回 `protocol` 三态结果）与 WebSocket 的
  一消息一帧（`decodeFrame`）各得其所。
- **手写错误 Status 解码**：失败响应内嵌的 Status（protobuf 二进制）由协议层
  自带的最小解码器还原为 `code / reason / message / metadata`，无需引入
  protobuf 运行时。
- **零宿主依赖**：协议层只用 JS 语言标准能力——UTF-8 编解码自带实现
  （不依赖 `TextEncoder`/`TextDecoder`），产物 target 为 ES2020。浏览器、Node、
  Cocos Creator 等嵌入式 JS 引擎（原生 JSB 环境）均可直接使用。
- **协议一致性**：与 Go SDK 消费同一份 22 用例字节级 golden vectors（向量源在
  atlas 主仓，规范与向量同仓），CI 逐用例对拍，行为跨语言一致。

## 环境要求

- Node.js **≥ 22**（运行测试与构建；产物本身兼容所有 ES2020 运行环境）；
- 浏览器 / Cocos Creator：直接引入产物，无环境要求。

## 安装

npm 包尚未发布，当前可克隆构建或以 git 依赖使用：

```bash
git clone https://github.com/huangyuCN/atlas-sdk-ts
cd atlas-sdk-ts && pnpm install && pnpm build   # 产物在 dist/
```

## 快速开始

### 组装一个请求帧

```ts
import { buildRequestBody, encodeFrame, encodeUtf8, MsgType } from '@huangyucn/atlas-sdk-ts';

// body = [opLen:u16][operation][payload]（payload 为 JSON 字节）
const body = buildRequestBody('/gateway.v1.GatewayAuth/Login',
  encodeUtf8(JSON.stringify({ playerId: 'p1' })));

// 帧头 16 字节大端 + body；magic/version 传 0 自动补协议默认值
const frame = encodeFrame({ magic: 0, version: 0, type: MsgType.Request, seq: 1, length: 0 }, body);

// frame 即可写入 TCP socket / WebSocket（二进制消息）
```

### 解析一个响应

```ts
import { decodeFrame, decodeReply, decodeUtf8, parseRequestBody } from '@huangyucn/atlas-sdk-ts';

// WebSocket：一条消息 = 一个完整帧
const { header, body } = decodeFrame(wsMessage);

// 响应包络：成功 [0][dataLen][data]；失败 [1][statusLen][Status][dataLen][data]
const reply = decodeReply(body);
if (reply.status) {
  // 服务端业务拒绝：按 reason 分支
  if (reply.status.reason === 'PLAYER_NOT_FOUND') {
    console.log('玩家不存在:', reply.status.message);
  }
} else {
  const dto = JSON.parse(decodeUtf8(reply.data));
}
```

### TCP 字节流切帧（Node）

```ts
import { readFrameFrom, type FrameRead } from '@huangyucn/atlas-sdk-ts';

// 字节流到达顺序不保证按帧对齐，累积缓冲后循环切帧
let buffer = new Uint8Array();
const append = (buf: Uint8Array, chunk: Uint8Array): Uint8Array => {
  const out = new Uint8Array(buf.length + chunk.length);
  out.set(buf);
  out.set(chunk, buf.length);
  return out;
};

socket.on('data', (chunk: Uint8Array) => {
  buffer = append(buffer, chunk);
  for (;;) {
    const res: FrameRead = readFrameFrom(buffer); // 流式三态
    if (!res.ok) {
      if (res.reason === 'incomplete') break;     // 等更多数据
      throw res.cause;                            // protocol：协议错误，终止连接
    }
    handleFrame(res.header, res.body);
    buffer = buffer.subarray(res.consumed);       // 消费已读字节，继续切下一帧
  }
});
```

## 兼容性

| 运行环境 | 协议层 | 通道传输（开发中） |
|---------|--------|------------------|
| 浏览器（现代 ES2020 引擎） | ✅ | WebSocket |
| Node.js ≥ 22 | ✅ | WebSocket / TCP / UDP |
| Cocos Creator（Web 构建） | ✅ | WebSocket |
| Cocos Creator（原生 JSB） | ✅ | WebSocket（引擎 JSB 绑定） |

说明：嵌入式 JS 引擎宿主不保证提供 `TextEncoder`/`TextDecoder`（它们是宿主 API
而非语言标准），本 SDK 的 UTF-8 编解码为自带实现，因此协议层在任何 ES2020 环境
可直接使用；通道层在引擎宿主仅 WebSocket 可用（TCP/UDP 无 JS 绑定）。

## DTO

游戏项目的消息 DTO 无需手写，由 atlas CLI 从 proto 定义生成：

```bash
atlas sdk gen --lang ts --protoset <protoc --descriptor_set_out 产物> --out dto
```

产物按 proto 包分目录（如 `gateway/v1/`、`battle/v1/`），以相对导入使用，
生成物为纯 interface + 判空/64 位整数辅助（64 位整数线上为字符串）。

## 开发

```bash
pnpm install    # 安装依赖（pnpm ≥ 10）
pnpm test       # 单测 + golden vectors 对拍（22 用例，与 Go SDK 同一份向量）
pnpm typecheck  # tsc --noEmit（strict）
pnpm build      # tsup → dist/（ESM + CJS + d.ts）
pnpm bench      # 协议层 benchmark
```

> golden vectors 向量包在 atlas 主仓 `testdata/golden/`。本地测试默认读取与本仓
> 同级的 `../atlas/testdata/golden`，或用环境变量 `ATLAS_GOLDEN_DIR` 指定。

## 路线图

- [x] v0.1：协议层帧编解码 + golden 对齐 + 引擎宿主兼容加固
- [x] v0.2：运行时内核（Invoke 请求匹配、Notify 订阅、双层心跳、重连与 dual 编排）
- [ ] v0.3：通道传输（浏览器 WebSocket → Node TCP/UDP）
- [ ] v0.4：真服务端到端验收（注册/登录/匹配/战斗/结算闭环）

## License

[Apache License 2.0](LICENSE)
