# 开发路线与实施指引

> 协议规范（唯一事实源，只读参考）：atlas 主仓
> `docs/superpowers/specs/2026-08-28-client-sdk-multilang-design.md`。
> 服务端对接基准：atlas `feat/actor` 分支顶点 `40d8e74`（2026-09-01，当前与 main 同顶点；
> golden manifest `atlasCommit` 字段锁定）。golden 向量源：atlas 主仓 `testdata/golden/`
> （协议单点：规范与向量同仓，transport/frame -update 生成；本仓 CI 检出 atlas
> `feat/actor` 注入 `ATLAS_GOLDEN_DIR`，用例数以 manifest 为准动态消费，新增用例无需改本仓）。

## 当前状态（2026-09-03，v0.4 真网关验收完成——TS 侧路线图收官）

- **v0.4 交付**：对集成服务器 10.10.9.36 真网关（模板四服务 feat/actor 基线）的
  端到端验收全绿，脚本 `examples/smoke.mjs`（四形态，对齐 Go smoke 口径）+
  `examples/mock-gateway.mjs`（本地 mock 验证脚本逻辑）。验收记录（2026-09-03）：
  - **TCP 业务闭环**（9001）：注册 → 登录 → 业务心跳 3 次往返 → 冒烟通过；
  - **WS single 闭环**（9002）：同上全绿（single 形态：WS 承载业务+战斗）；
  - **UDP 战斗协议通道探针**（9004）：拨号 → 传输心跳往返探针 OK（模板 D6：战斗
    通道不做业务 Login，会话绑定业务通道）；
  - **dual 双通道闭环**（TCP 业务 + WS 战斗）：业务登录 + 战斗通道心跳 + 链式编排；
  - **断线重连演练**（dual + `--reconnect-after` 重启真网关）：双通道自动重连 →
    业务重登成功（新令牌）→ 战斗通道重绑定 → 业务心跳恢复 → 冒烟通过。
  - 环境备注：依赖容器（etcd/redis/nats）因服务器重启曾退出，`docker start` 恢复；
    gateway 重启用 `pkill -x gateway` + `setsid nohup`（`pkill -f` 会自匹配 ssh
    命令行误杀自身）。
- **库层补齐**：`nodeDialer()`（dual 异构传输按通道 kind 分派 tcp/udp/ws）+
  `newTCPClient`/`newUDPClient`/`newDualClientNode` 便捷构造；132 测试全绿。
  脚本缺陷修复记录：`waitSignal` 超时分支改为可取消（原实现泄漏的 fail 定时器在
  close 后误触发退出）。

## 前序状态（2026-09-03，v0.3 通道传输完成）

- **v0.3 交付**（16 个通道用例，总计 130 测试全绿）：
  - **WebSocket 通道**（主入口，零平台依赖）：`WebSocketLike` 最小公约接口
    （on* 事件 + send/close）桥接浏览器原生 WS 与 Cocos JSB WS，一条消息 = 一个
    完整帧；`connectWebSocketTransport`（open 等待/超时）+ `dialWebSocket`
    （ws://wss:// URL 或 host:port+path，默认 /ws）；文本消息/帧非法 → 协议错误
    终止；`newWSClient(url, opts, wsFactory?)` 便捷构造。
  - **Node TCP 通道**（`@huangyucn/atlas-sdk-ts/node` 子入口）：node:net +
    累积缓冲游标 + `readFrameFrom` 切帧（data 事件只累积与唤醒，maxBodySize
    语义在读取时校验不旁路）；粘包/半包实测；帧协议非法 → ProtocolError
    （内核终止不重连）；`newTCPClient`。
  - **Node UDP 通道**（同子入口）：node:dgram 面向连接（对齐 Go DialUDP）；
    一报一帧；写侧 64KiB（含帧头）提前拦截；坏数据报静默丢弃（软跳过）；
    `newUDPClient`。
  - **构建**：tsup 多入口（`index` 零平台依赖 + `node` 含 node:net/dgram），
    package.json `exports["./node"]` 子入口；主入口产物经特征串核查零
    node: 引用（浏览器/嵌入式宿主安全承诺兑现）。
  - 测试形态：WS 用 mock WebSocket 工厂（on* 事件手控）；TCP/UDP 用 node
    真实回环 socket（本地回环无外部依赖，CI 可跑）；真网关集成冒烟属 v0.4。

## 前序状态（2026-09-03，v0.2 运行时内核完成）

- **v0.2 交付**（`src/client/`，测试全绿（数量以 CI 为准），语义与 atlas-sdk-go/client 逐条同源）：
  - **错误四分类**：`AtlasError` 抽象基类（cause 手动赋值）+ `BusinessError`/
    `NetworkError`/`TimeoutError`/`ProtocolError`；`isBusinessError(err, reason)`
    按 Reason 精确匹配；内核 ProtocolError 在读循环边界包装协议层哨兵（cause 链），
    两层分类哨兵独立成立（依赖方向不反转）。
  - **Invoke**：`(epoch, seq)` in-flight 匹配（seq 跨重连不重置）、恰一次结算
    （超时先到响应静默丢弃）、per-call `WithRequestTimeout`/`WithFailFast`、
    序列化插槽（默认 JSON，序列化失败归协议错误）。
  - **Notify 订阅**：多路订阅、同 handler 幂等去重、退订句柄幂等、handler 异常
    隔离（同步/异步双路径），订阅生命周期归通道（重连自动生效）。
  - **重连 supervisor**：首连失败拒绝构造（对齐 Dial 语义）；重连退避（±20% 抖动）
    + 钩子同步执行（hookBypass 直通窗口、上限 hookTimeout、超时弃用本代）+
    settle 后 drain 排队（FIFO：排队严格先于新请求，drain 期间新请求继续入队）；
    网络断连立即置 Reconnecting（无「连接已死仍 Connected」窗口）；协议级致命
    终止不重连。
  - **双层心跳**：传输心跳业务拒绝不计死链、网络失败连续 3 次判死链按代关闭；
    会话心跳仅业务通道门控、业务错误 CAS 单飞触发重登、工厂未就绪跳过、
    网络错误静默。
  - **dual 编排**：`newDualClient` 业务+战斗通道独立心跳/重连/排队/钩子；
    链式重绑（业务重登成功 → 战斗 Join 重绑，战斗未就绪跳过本轮）；链式钩子
    追加在业务通道配置自身（战斗 Opts 永不外溢）；`Client.State()` 聚合向下降级
    （connected < connecting/reconnecting < disconnected）；`ChannelView` 视图
    （生命周期归 Client）。
  - **优雅关闭**：幂等 Close，in-flight 与排队请求统一 `NetworkError`。
  - 实现修复记录：结算入口统一走 `settleInflight`（修复双重删除导致 resolve
    永不执行）；首连与重连场景分离（首连不执行钩子/不退避）。
  - 文件结构：`channel.ts`（连接本体 436 行）/`readloop.ts`（读循环与帧分发）/
    `reconnect.ts`（supervisor）/`heartbeat.ts`（双层心跳）/`notify.ts`（订阅表）/
    `client.ts`（编排器）/`errors.ts`/`options.ts`/`serializer.ts`/`transport.ts`
    （接口 + 内存 mock）。

## 前序状态（2026-09-01，v0.1 立项 + 协议层交付 + 引擎宿主兼容加固）

- **立项交付**：
  - 仓骨架：pnpm + tsup（ESM + CJS + d.ts 三形态，`target ES2020`）+ vitest +
    tsc strict（`noUncheckedIndexedAccess`）；`engines.node >= 22`（Node 20 已于
    2026-04 结束维护期，pnpm 11 亦要求 ≥22.13）；
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

## v0.2：运行时内核（已完成，见顶部状态）

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

## v0.5：发布工程 + 二进制 protobuf 演进（打样就绪）

- **A. npm 发布工程（已完成，发布就绪形态）**：
  - 包元数据完善（repository/bugs/homepage/keywords/sideEffects=false）；
    首发版本 **0.5.0**（语义化版本策略：0.x 阶段 minor = 功能批次，patch = 修复；
    1.0 门槛 = API 稳定承诺 + 发布定稿；包名占位 `@huangyucn/atlas-sdk-ts`，§10 待定项可改）；
  - `.github/workflows/publish.yml`：tag `v*` 触发（或手动 dry_run）——测试（含 golden
    对齐）→ 构建 → pack 预检 → `npm publish --access public`（NPM_TOKEN secret 由
    使用者配置；未配置时校验步骤照常、发布步骤明确报缺凭证）；
  - `npm pack --dry-run` 验证：17 文件全为 dist 产物 + README/LICENSE，179.1 kB。
- **B. 二进制 protobuf 演进（打样就绪，2026-09-04 随规范 §3.1 载荷编码协商设计）**：
  规范先行（规范修订已写入 atlas 主仓）；Go 侧打样 ProtobufSerializer（本仓外部——
  atlas-sdk-go 本地批次）；TS 侧打样已完成，四个增量点（内核与现有 API 零破坏）：
  1. `frame`：`VERSION_2` 常量 + 版本白名单放宽（checkHeader 接受 {1,2}，未知版本仍拒绝）；
     `frame.Versioned` 可选接口（载荷编码版本声明——放协议层避免 contrib → client 依赖环）；
  2. `client`：`serializerVersion` 推导（未实现 Versioned 者默认 ver=1）；请求帧头 ver 由
     serializer 决定；响应帧头 ver 校验（不一致 = 失步，协议级致命终止不重连）；
  3. `./protobuf` 子入口：`ProtobufSerializer`（@bufbuild/protobuf 断言式，ver=2）——
     DTO 须为 @bufbuild message，schema 按 $typeName 注入 registry；依赖归子入口，
     主入口零 protobuf 依赖（层级镜像 Go contrib/protobuf）；
  4. **测试**：frame 白名单（1/2/未知拒绝）+ ver=2 帧往返 + serializerVersion 推导 +
     ver=2 invoke（透传形态）+ @bufbuild DTO 端到端（往返/断言拒绝/未注册 schema/
     ver 不一致失步终止）；全量 143 测试绿，主入口产物 0 处 @bufbuild 引用。
- **边界（对齐 Go roadmap 口径）**：服务端支持 ver=2 前勿在真实连接启用（打样就绪形态）；
  golden vectors 二进制形态用例（atlas 主仓向量包先加形态、两侧再消费）与生成器产
  op → input/output schema 映射（kernel resp-target 全自动绑定）属后续批次。

## 后续（随规范路线）

- C# 仓（规范 P3）跟进后，跨仓 CI 机器人（向量更新 PR + 每日冒烟，规范 P5）。

## 开发约定

- 新增/变更线格式：**先改 atlas 规范 + golden vectors，四语言实现跟进——规范先行**；
- golden 对齐测试是每次 CI 的硬性门槛（向量源 pin commit 见 CI 配置）；
- 全部手写代码中文注释；TDD 测试先行；单文件 ≤ 500 行、单函数 ≤ 50 行；
- 命名不以包名开头（如 `frame/Header` 而非 `FrameHeader`）。
