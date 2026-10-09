# 变更日志（CHANGELOG）

本仓遵循[语义化版本](https://semver.org/lang/zh-CN/)：0.x 阶段 **minor = 功能批次**、
**patch = 修复**；1.0 门槛 = API 稳定承诺 + 发布定稿。条目按「破坏性 / 新增 / 修复 / 文档」
分组，破坏性变更以 **⚠ 破坏性** 显式标注并写明迁移动作。版本号唯一来源是 `package.json`
的 `version`（`src/version.ts` 的 `CLIENT_VERSION` 由构建期注入，不手写）。

> 0.7.0 之前本仓无独立变更日志，下方 0.6.0 / 0.5.0 条目按 git 历史**追记**。

## 0.7.0 — 2026-10-09

战斗帧直连（阶段 3）整批上线 npm。对应提交区间 `a9bff93`（0.6.0）→ `9c9699d`。

### ⚠ 破坏性变更

- **战斗帧改直连，不再经网关**（`530b88a`）：`JoinBattle` / `SendFrameInput` / `SyncFrames` /
  帧广播 / 结算推送改由「接入层地址 + 本局 `battle_ticket`」直连接入层（阶段 3，L4 转发），
  网关只剩单一业务通道（登录/匹配等 op）。**老客户端（0.6.0 及更早）无法连接阶段 3 服务端，
  必须升级**。
  - 接入层地址**唯一来源是本局成局推送**（`/game.v1.MatchStartedNotify` 的 `endpoints[]`）：
    SDK 不读本地配置、不猜端口、不换面；缺本 SDK 支持的面即明确报错，
    `EDGE_TRANSPORT_UNSPECIFIED` 一律拒绝（浏览器只有 `EDGE_TRANSPORT_WS`）。
  - 一张票两处用：WS 升级 query `?ticket=<base64url>` + 每个战斗帧的会话槽带同一张票；
    票据不含后端地址，属主迁移后同一张票仍能跟到新属主。
- **对局结束语义收口**（`8bffdd1`）：结束（首份结束通知或任意 `BATTLE_ENDED(409)` 回执，
  含心跳 Ping 的回执）后**业务帧与心跳全部停发**（零写线），后续调用抛
  `BusinessError(409, BATTLE_ENDED)`；在途请求也以该 `Status` 结算；`ended()` 一旦为真即
  **永久为真**（close 后仍可判定）；结束通知**恰一次**回调（重复副本不再回调，仍经 `onPush`
  透传），收尾窗口 `drainMs` 缺省 2000ms。
  - 语义分界（三语言一致）：**`ended` ⇒ 有结算可展示**；**`failed` ⇒ 无结算的终态拒绝**。
- **终态族收紧 + 心跳被拒可判定**（`9c9699d`）：
  - `BATTLE_NOT_FOUND(3001)` / `BATTLE_FULL(3002)` / `FRAME_TARGET_MISMATCH(403)` 为
    **不可重试终态**：停发 + 释放连接 + 在途请求立即以终态 `Status` 本地结算
    （metadata 标 `x-atlas-sdk-local-settled`），`onFailed` 恰一次。
  - 票类（`BATTLE_TICKET_INVALID` / `BATTLE_TICKET_EXPIRED`）**不终态**：上报可判定信号
    （`isBattleTicketRejected` 等），由上层回业务链路重新取票（SDK 不自动重取票）。
- **`stats()` 口径拆分**（`9c9699d`）：新增 `endedRejects`（正常结束，有结算）与
  `fatalRejects`（无结算的终态拒绝）；`terminalRejects` 保留为两者派生总和。以
  `terminalRejects` 单一计数做分支的调用方应改用族判定入口
  （`isBattleEnded` / `isBattleTerminalReject`）。
- **生成物跟随模板 proto**（`793df8e`）：DTO / 会话 stub / 冒烟 schema 从上游生成物整体
  刷新（按传输面下发地址、`PlayerOutNotify`、migration 字段）——直接按字段名读生成 DTO 的
  调用方需同步。

### 新增

- **直连保活心跳**（`937c8b2`）：`heartbeatMs` 缺省 2000ms（`0` 关闭，须严格小于
  `battle.offline_timeout / 3`），自续期单循环、走直连 WS 同一通道的 Tell（置会话槽票、
  不带幂等键、不登记 pending、恢复入局中跳过本轮）；心跳失败**只上报**
  （`onHeartbeatFailed`，回调异常隔离），不改状态、不重连、不终止会话。
- **跨机闭环驱动** `examples/battle-direct-loop.mjs`（`937c8b2`）：经网关取票 → 按
  `EDGE_TRANSPORT_WS` 取接入层地址 → 直连跑入局/发帧/补帧/收广播 + 保活与结束收口断言。

### 修复 / 内核

- 帧编解码改**消费框架生成物**（`1a0e7d9`）：`src/frame/gen/` 由 `scripts/gen-dto.sh` 复制
  生成物，`checkHeader` / `encodeFrame` / `decodeFrame` / `readFrameFrom` 全部转发生成物，
  手写字节解析删净；对外 API 名与 `ProtocolError` 语义保持不变。
- `close()` × 在途重连竞态（`9c9699d`）：close 递增连接代次，安装前复查代次与 closing，
  作废即关 socket 且拒装——修掉「close 后状态回退 connected、仍写 2 帧、socket 泄漏」。
- 心跳被拒不再被 settle 丢弃（`9c9699d`）：有界记账（8 拍）后再按族判定，票类首见上报一次。

### 文档

- README 补战斗直连口径、终态与错误判定表、`stats()` 字段说明（`9c9699d`）；roadmap 与
  安装说明随 0.7.0 更新。

### 已知小问题（待办，不阻塞本次发布）

- **`exports` 未按条件声明 `require.types`**：`dist/index.d.cts`、`node.d.cts`、
  `protobuf.d.cts` 已构建并随包发布，但三个子入口的 `exports` 各自只声明一个 `types`
  条件（指向 ESM 形态的 `.d.ts`），`.d.cts` 实际不可达（属死重量，约 2 kB/文件）。
  - 实测（TypeScript 5.9.3 + `moduleResolution: nodenext`）：CJS 消费者的
    `import x = require(...)` 与 `import { … } from '…'` 两种写法都解析到 `index.d.ts`，
    **零报错**（TS 5.8+ 已建模 Node ≥ 22.12 的 `require(esm)`，本包 `engines.node ≥ 22`），
    对当前工具链**无影响**；仅当消费方用 TypeScript ≤ 5.7 时才可能触发 TS1479
    （CommonJS 文件引用 ESM 声明）。
  - **刻意不在发布前修**：最后一刻改 `exports` 解析契约的风险大于收益，记为待办。
  - 将来修法（三个子入口一致处理）：
    ```json
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" },
    "import":  { "types": "./dist/index.d.ts",  "default": "./dist/index.js"  }
    ```

## 0.6.0 — 2026-09-28（追记）

- **首版发布到 npm**（`a9bff93`）。协议层（帧编解码 + 手写 Status 解码）、运行时内核
  （请求匹配、推送订阅、双层心跳、断线重连、dual 双通道编排）、通道传输（WebSocket /
  Node TCP、UDP）齐全；产物 ESM + CJS + d.ts 三形态。
- 新增 `./protobuf` 子入口（`@bufbuild/protobuf`，载荷编码 ver=2 打样）：依赖归子入口，
  主入口与内核零 protobuf 运行时依赖。

## 0.5.0 — 2026-09-04（追记，未发布到 npm）

- npm 发布工程就绪（`a91d141`）：包元数据（repository / bugs / homepage / keywords /
  `sideEffects: false`）、`.github/workflows/publish.yml`（tag `v*` 触发：测试 → 构建 →
  `npm pack --dry-run` 预检 → `npm publish --access public`）。
- 本版本仅「发布就绪形态」，npm 上无 0.5.0 产物；首个发布版本为 0.6.0。
