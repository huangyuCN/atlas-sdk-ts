# atlas-sdk-ts

[![CI](https://github.com/huangyuCN/atlas-sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/huangyuCN/atlas-sdk-ts/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Atlas 帧协议的 TypeScript 客户端 SDK。浏览器与 Node 双目标（产物同时提供
ESM / CJS / d.ts 三种形态），面向游戏客户端、机器人与工具脚本连接
[Atlas](https://github.com/huangyuCN/atlas) 游戏服务端。

> **当前状态**：协议层、运行时内核（请求匹配、推送订阅、双层心跳、断线重连、
> dual 双通道编排）与通道传输（浏览器/Cocos WebSocket、Node TCP/UDP）均可用；
> **战斗帧直连**（阶段 3：凭票据直连接入层，不再经网关）已落地并通过跨机 WS 闭环验收，
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

已发布到 npm（包版本即本仓 `package.json` 的 `version`，随本仓版本走）：

```bash
npm i @huangyucn/atlas-sdk-ts@0.7.0     # pnpm add / yarn add 同义
```

也可克隆构建或以 git 依赖使用：

```bash
git clone https://github.com/huangyuCN/atlas-sdk-ts
cd atlas-sdk-ts && pnpm install && pnpm build   # 产物在 dist/
```

子入口按需引入：主入口 `@huangyucn/atlas-sdk-ts`（协议层 + 内核 + WebSocket，零 protobuf
运行时依赖）、`@huangyucn/atlas-sdk-ts/node`（Node TCP/UDP 通道）、
`@huangyucn/atlas-sdk-ts/protobuf`（基于 `@bufbuild/protobuf` 的二进制序列化器，ver=2）。

## 快速开始

### 组装一个请求帧

```ts
import { buildRequestBody, encodeFrame, encodeUtf8, MsgType } from '@huangyucn/atlas-sdk-ts';

// body = [opLen:u16][operation][payload]（payload 为 JSON 字节）
const body = buildRequestBody('/gateway.v1.Session/Login',
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

## 战斗帧直连（阶段 3）

阶段 3 起，**战斗帧不走网关**：客户端凭「接入层地址 + 战斗票据」直连接入层（L4 转发器），
网关只剩单一业务通道（登录/匹配等 op 调用）。两条链路分工如下：

| 链路 | 承载 | 入口 | 身份凭据 |
|------|------|------|---------|
| 业务通道 | 会话/匹配等 op（请求-响应） | 网关（`newWSClient(gateway)`） | 会话令牌（登录后） |
| 战斗帧直连 | `JoinBattle` / `SendFrameInput` / `SyncFrames` / 帧广播 / 结算推送 | **接入层**（地址来自本局推送） | 本局 `battle_ticket` |

口径要点（与 Go / C# SDK 一致）：

- **地址唯一来源是本局推送**：成局推送（`MatchStartedNotify`，op 为**消息完整名**
  `/game.v1.MatchStartedNotify`）携带 `battle_ticket` 与 `endpoints[]`；SDK 不读本地配置、
  不猜端口、不换面——缺本 SDK 支持的面（浏览器只有 `EDGE_TRANSPORT_WS`）即明确报错，
  `EDGE_TRANSPORT_UNSPECIFIED` 一律拒绝（proto 明示不得下发）。
- **一张票两处用**：WS 升级 query `?ticket=<base64url>`（接入层据此验票并选后端）+
  每个战斗帧的**会话槽**带同一张票（battle 侧据此认人）。票据不含后端地址，属主迁移后
  同一张票仍能跟到新属主。
- **零 protobuf 运行时依赖**：推送与回执按帧头 `version` 分派（1 = protojson、2 = 二进制）；
  直连路径不需要 DTO 也能跑通（需要结构化字段时再用生成 DTO）。
- **保活**：`heartbeatMs`（缺省 2000ms）周期发 `Ping`（Tell，无回执）；心跳失败只上报，
  绝不终止会话。

### 直连示例

```ts
import {
  openBattleSession, parseDirectPlan, isBattleTerminalReject, isBattleTicketRejected,
} from '@huangyucn/atlas-sdk-ts';

// ① 业务链路（网关）：入队匹配 → 等成局推送（推送 op = 消息完整名）
client.on('/game.v1.MatchStartedNotify', (_op, payload) => {
  void openBattleSession(parseDirectPlan(payload), {
    heartbeatMs: 2000,                                   // 保活（显式 0 关闭）
    onFrame: (payload, version) => { /* 帧广播（按 version 解码） */ },
    onBattleEnd: (payload) => { /* 结算结果：同一局恰一次（重复投递已幂等） */ },
    onFailed: (err) => {
      // 不可重试终止（含终态族业务拒绝：对局不存在/已满/目标不一致）→ 回匹配链路
      if (isBattleTerminalReject(err)) { /* 终态族：这一局已无用，不重连 */ }
    },
    onHeartbeatFailed: (err) => {
      // 心跳写失败，或心跳回执被业务拒绝；票类信号在此判定：
      if (isBattleTicketRejected(err)) { /* 需回业务链路重新取票（自动重取票由上层做） */ }
    },
  }).then(async (s) => {
    await s.joinBattle();                                  // 显式入局（缺省 autoJoin 已在建连内完成；可取回 currentFrame）
    await s.sendFrameInput({ input: { frameId: '1' } });    // 上行帧输入
    await s.syncFrames();                                  // 补帧（按 lastSeenFrame）
    console.log(s.stats());                                // 重连/握手/心跳失败只读统计
  });
});
```

### 终态与错误判定

| 情形 | 判定入口 | 会话行为 |
|------|---------|---------|
| 对局已结束（`BATTLE_ENDED` / 结算推送） | `isBattleEnded(err)`、`ended()` | 停发（业务帧 + 心跳），收尾窗口内继续收结果，窗口到点释放连接 |
| 对局不存在 / 已满 / 票面对局与正文目标不一致（`BATTLE_NOT_FOUND` / `BATTLE_FULL` / `FRAME_TARGET_MISMATCH`） | `isBattleTerminalReject(err)`（族判定）、`isBattleNotFound` / `isBattleFull` / `isFrameTargetMismatch` | **不可重试终态**：停发、释放连接、`onFailed` 上报一次；在途请求立即以终态 `Status` 结算 |
| 票无效 / 过期（`BATTLE_TICKET_INVALID` / `BATTLE_TICKET_EXPIRED`） | `isBattleTicketRejected(err)`、`isBattleTicketExpired(err)` | **不终态**：上报可判定信号，由上层回业务链路重新取票（SDK 不自动重取票） |
| 接入层拒连（升级被断/无回执） | `isEdgeRejected(err)` | 不可重试：票可能已失效，回业务链路重新取票 |
| 纯网络断开 | `NetworkError`（`retryable=true`） | 退避重连（窗口 `reconnectWindowMs`，用尽即判拒连） |

> 终态两族的语义分界（三 SDK 一致）：**`ended` 表示对局正常结束、有结算可展示**；
> **`failed` 表示无结算的终态拒绝**——两者的区别就是「有没有结算可展示」，上层据此决定
> 是否去取结算数据（对 `failed` 取结算只会拿到不存在的数据）。判定入口：
> `ended()` / `isBattleEnded(err)` 对第一族，`isBattleTerminalReject(err)` 对两族（族内细分
> 用 `isBattleNotFound` / `isBattleFull` / `isFrameTargetMismatch`）。

`stats()` 给出只读快照：`dialAttempts` / `dialFailures`（握手）/ `reconnects`（重连成功）/
`heartbeatWriteFailures` / `heartbeatRejected` / `heartbeatTicketRejected` /
`lastHeartbeatRejectReason` / `terminalRejects`（终态总数）/
`endedRejects`（对局正常结束，有结算）/ `fatalRejects`（无结算的终态拒绝）。

跨机验收驱动：`node examples/battle-direct-loop.mjs --gateway <host:port>`
（业务链路取票 → 经接入层直连 → 发帧/补帧/收广播 → 保活与结束收口逐帧断言）。

## 兼容性

| 运行环境 | 协议层 | 内核 | 通道传输 |
|---------|--------|------|---------|
| 浏览器（现代 ES2020 引擎） | ✅ | ✅ | WebSocket |
| Node.js ≥ 22 | ✅ | ✅ | WebSocket / TCP / UDP |
| Cocos Creator（Web 构建） | ✅ | ✅ | WebSocket |
| Cocos Creator（原生 JSB） | ✅ | ✅ | WebSocket（引擎 JSB 绑定） |

说明：嵌入式 JS 引擎宿主不保证提供 `TextEncoder`/`TextDecoder`（它们是宿主 API
而非语言标准），本 SDK 的 UTF-8 编解码为自带实现，因此协议层在任何 ES2020 环境
可直接使用；通道层在引擎宿主仅 WebSocket 可用（TCP/UDP 无 JS 绑定）。

## DTO 与会话协议接缝

游戏项目的消息 DTO 无需手写：项目里执行 `make proto`，框架的 `protoc-gen-atlas-client`
（`--atlas-client_opt=lang=ts`）会按 proto 把 DTO 与 op stub 生成到项目的 `api/client/ts/**`。

本仓自身的 DTO / 帧常量 / 会话 stub 副本**只从上游生成物刷新**（不手写、不二次定义）：

```bash
bash scripts/gen-dto.sh   # 帧常量取自框架仓（ATLAS_DIR），会话 stub 取自模板仓生成物
```

产物按 proto 包分目录（如 `gateway/v1/`、`battle/v1/`），以相对导入使用，
生成物为纯 interface + 判空/64 位整数辅助（64 位整数线上为字符串）。

会话状态机（登录/恢复/心跳/被踢）不引用任何会话消息类型，只依赖**会话协议接缝**
`SessionProtocol`（5 个 op + 取 token/playerID/过期时间 + 被挤下线推送识别与原因提取）；
项目侧用生成物一行接入：

```ts
const session = newSession([withSessionProtocol(newGatewayV1SessionProtocol())]);
session.bind(client);
await session.login({ playerId, password });   // 自动带 client_version（见 src/version.ts）
```

参考实现见 `examples/gatewayv1.mjs`（op 名由生成的服务描述符推导，字段名按生成 DTO 读取）。
接缝收到的推送载荷是**未解码的原始字节**（`Uint8Array`）——SDK 对推送不做解码，由接缝
实现用生成的 `KickedNotify` DTO 自行解码取 `reason`（三语言同一约定）。

## 开发

```bash
pnpm install    # 安装依赖（pnpm ≥ 10）
pnpm test       # 单测 + golden vectors 对拍（24 用例，与 Go SDK 同一份向量）
pnpm typecheck  # tsc --noEmit（strict）
pnpm build      # tsup → dist/（ESM + CJS + d.ts）
pnpm bench      # 协议层 benchmark
bash scripts/gen-dto.sh   # 从上游生成物刷新协议事实（帧常量/会话 stub/冒烟 schema）
```

> golden vectors 向量包在 atlas 主仓 `testdata/golden/`。本地测试默认读取与本仓
> 同级的 `../atlas/testdata/golden`，或用环境变量 `ATLAS_GOLDEN_DIR` 指定。

> `gen-dto.sh` 只读消费上游：帧常量取自框架仓（`ATLAS_DIR`，默认同级 `../atlas`），
> 会话 stub 与冒烟 schema 取自模板仓 descriptor set（`ATLAS_LAYOUT_DIR`，默认同级
> `../atlas-game-layout`）。产物全部入库，CI 有「重生成无 diff」门禁。

## 路线图

- [x] v0.1：协议层帧编解码 + golden 对齐 + 引擎宿主兼容加固
- [x] v0.2：运行时内核（Invoke 请求匹配、Notify 订阅、双层心跳、重连与 dual 编排）
- [x] v0.3：通道传输（WebSocket 全平台 / Node TCP、UDP）
- [x] v0.4：真服务端端到端验收（注册/登录/匹配/战斗/结算闭环）
- [x] v0.5：发布工程 + 二进制 protobuf 演进（打样就绪）
- [x] v0.6：战斗帧直连（阶段 3：凭票据经接入层直连 WS 面，跨机验收通过）
- [x] v0.7：直连上线 npm（保活心跳 + 对局结束语义收口 + 评审 P0/P1 修复；**破坏性**：
  战斗帧改直连、老客户端须升级，详见 [CHANGELOG](CHANGELOG.md)）

## License

[Apache License 2.0](LICENSE)
