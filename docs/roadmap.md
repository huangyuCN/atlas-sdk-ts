# 开发路线与实施指引

> 协议规范（唯一事实源，只读参考）：atlas 主仓
> `docs/superpowers/specs/2026-08-28-client-sdk-multilang-design.md`。
> 服务端对接基准：atlas `feat/actor` 分支顶点 `40d8e74`（2026-09-01，当前与 main 同顶点；
> golden manifest `atlasCommit` 字段锁定）。golden 向量源：atlas-sdk-go 仓
> `testdata/golden/`（21 用例，四语言同一份；本仓 CI pin 该仓 commit `d212872`，
> 向量更新时同步推进）。

## 当前状态（2026-09-01，v0.1 立项 + 协议层交付 + 引擎宿主兼容加固）

- **立项交付**：
  - 仓骨架：pnpm + tsup（ESM + CJS + d.ts 三形态，`target ES2020`）+ vitest +
    tsc strict（`noUncheckedIndexedAccess`）；`engines.node >= 20`；
    浏览器与 Node 双目标约定：**协议层/内核零平台依赖**（仅 JS 语言标准能力），
    平台差异收敛在传输层。
  - **协议层帧编解码（`src/frame/`）全量交付并 golden 对齐全绿（74 测试，含 21 用例
    golden 对拍）**：`encodeFrame`/`decodeFrame`（消息边界，WS 形态）、`readFrameFrom`
    （流式缓冲三态——incomplete/protocol，TCP/KCP 形态，语义与 Go `frame.Read` 同构）、
    `buildRequestBody`/`parseRequestBody`（[opLen:u16][op][payload]）、`decodeReply`
    （响应包络，statusLen=0 容忍为零值 Status）、`decodeStatus`（手写 Status protobuf
    wire 解码：varint 含 int32 补码/10 字节上限判定、map entry、未知字段静默跳过）、
    `ProtocolError`（错误分类哨兵，对拍 golden「protocol」分类）。
  - 对拍口径与 `atlas-sdk-go/frame/golden_assert_test.go` 完全同构（宽松字段对比、
    incomplete→network / 校验失败→protocol 分类映射）。
- **引擎宿主兼容加固（2026-09-01 同日，面向 Cocos Creator 等嵌入式 JS 引擎宿主，
  约定已回写规范 §4/§7）**：
  1. **手写 UTF-8（`src/frame/utf8.ts`）**：`TextEncoder`/`TextDecoder` 是 Web/Node
     宿主 API 而非 JS 语言标准，Cocos 原生 JSB 环境不保证提供——协议层自带实现并
     对齐宿主语义（encode：lone surrogate → U+FFFD；decode：严格模式无效序列抛
     ProtocolError、BOM 剥离、ASCII 快路径），`body.ts`/`status.ts` 已切换；
  2. **产物 target 降至 ES2020**（Cocos 原生 JSB 对 ES2022 语言特性支持无保证，
     协议层无 ES2022 独有语法，代价≈0）；
  3. **错误 `cause` 手动赋值约定**（不依赖 ES2022 语言内置 `Error.cause`；v0.2 的
     `AtlasError` 基类按此实现）、**`AbortSignal` 仅作可选入参**（Invoke 超时用
     内置定时器，内核 v0.2 设计约束）。
  - benchmark 基线（微秒级，无退化）：encodeFrame ~0.24µs/op、decodeFrame ~0.11µs/op、
    decodeReply ~1.1µs/op、decodeStatus ~4.5µs/op。

## v0.2：运行时内核（下一批次）

按规范 §5 逐条实现（语义与 atlas-sdk-go/client 同源，TS idiom 表达）：

- **Invoke**：`(epoch, seq)` 匹配（Promise + AbortSignal）、per-call timeout/failFast、
  超时与响应竞态语义（恰一次结算，§5.2）；
- **Notify 订阅**：`On(op, handler)` 多路订阅 + 退订句柄 + 幂等去重 + 重连后自动重放
  （服务端客户端引擎是单 handler 替换式，多路订阅是 SDK 增量价值，§0）；
- **双层心跳**：传输 Ping（业务拒绝不计死链、连续 N 次判死链、按代精确匹配）+
  会话心跳（仅业务通道 kind 门控、CAS 单飞触发重登，§5.2）；
- **指数退避重连**：base 500ms ×2 上限 30s 带抖动；seq 跨重连不重置；请求排队
  （上限可配、failFast 直通）；重连钩子同步执行 + hookBypass 直通窗口
  （窗口上限 = hookTimeout、外部并发 Invoke 同样直通，§5.2）；
- **dual 双通道编排**：`Channel(kind)` 视图、`Client.State()` 聚合向下降级
  （劣化序 Connected < Reconnecting < Disconnected）、业务重登成功 → 战斗 Join
  链式重绑、每通道独立心跳/重连/排队/钩子；
- **错误四分类**：BusinessError/NetworkError/TimeoutError/ProtocolError
  （`AtlasError` 抽象基类 + `cause` 链路，§7）。

## v0.3：通道传输（浏览器 WS 优先 → Node TCP/UDP）

- 浏览器 WebSocket（原生 `WebSocket`，一条消息 = 一个完整帧，`decodeFrame` 直用；
  默认路径 `/ws`，对齐模板 WSURL 形态）——single 形态（WS 单通道业务+战斗）；
- **引擎宿主 WS 桥接**：Cocos Creator 原生构建的 WS 走引擎 JSB 绑定，API 与浏览器
  原生足够接近——通道层以最小 `WebSocketLike` 接口桥接两侧（binary 消息 +
  open/close/message 事件），避免按宿主分叉通道实现；
- Node TCP（`node:net` + 累积缓冲 + `readFrameFrom` 切帧）；
- Node UDP（`node:dgram`，一报一帧、单数据报上限 64KiB 含帧头、坏数据报静默丢弃，
  §2）；
- 浏览器不做 KCP（规范 §4 明确不首发；未来可选 WebTransport 另行决策）；引擎宿主
  同样仅 WS（TCP/UDP/KCP 无 JS 绑定，必须 dual 的项目需原生插件自研传输——规范 §4
  引擎宿主约定）。

## v0.4：真服务验收（集成服务器）

- 环境：10.10.9.36（gateway TCP 9001 / WS 9002 / KCP 9003 / UDP 9004 / HTTP 10080，
  SSH `shimmer-bi@10.10.9.36` 免密；常驻 etcd 12379 / redis 16379 / nats 14222）；
- 复刻模板 e2e：注册→登录→匹配→战斗→结算闭环，dual/single 双形态各跑一遍；
- 网关按用途绑定通道（模板 D6）：TCP/WS=认证协议，KCP/UDP=战斗协议；战斗通道
  不做业务 Login（每玩家单会话，二次登录顶掉业务通道会话），连通性验证用传输
  心跳往返（§4）。

## 后续（随规范路线）

- v0.5+：C# 仓（规范 P3）跟进后，跨仓 CI 机器人（向量更新 PR + 每日冒烟，规范 P5）；
- npm 包名与发布渠道为规范 §10 待定项（当前占位 `@huangyucn/atlas-sdk-ts`，可改）。

## 开发约定

- 新增/变更线格式：**先改 atlas 规范 + golden vectors，四语言实现跟进——规范先行**；
- golden 对齐测试是每次 CI 的硬性门槛（向量源 pin commit 见 CI 配置）；
- 全部手写代码中文注释；TDD 测试先行；单文件 ≤ 500 行、单函数 ≤ 50 行；
- 命名不以包名开头（如 `frame/Header` 而非 `FrameHeader`）。
