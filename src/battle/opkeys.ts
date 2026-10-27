// 会话自身收发/观察的 op 名（协议寻址键，**不是**消息类型）。
//
// 游戏域消息（battle / game / matcher 的 DTO、枚举与 op 常量）已迁到游戏自己的协议包，
// SDK 不再持有它们；但「会话本身要做什么」是传输/会话职责，必须有个名字可寻址：探针
// （心跳）、重连后的入局与补帧、帧广播与结束通知的识别。这些名字就是**线上的寻址键**——
// `op` 字段的取值本身即协议事实，与是否持有 DTO 无关（同 plan.ts 里成局推送 op 的处理口径）。
//
// 调用方发业务 op 时应优先用自己的协议包生成的 op 常量；本文件的常量覆盖会话自身会碰到的
// 全部 op（也作为配置 probe / replay 时的地址来源），避免 SDK 里再散落字面量。

/** OP_PING 是保活探针（heartbeat）的 op：无输入期间周期发送，维持帧面活跃。
 *  服务端语义是 Tell（不回业务回执），SDK 仍等帧引擎必回的空信封以捞出可判定失败。 */
export const OP_PING = '/battle.v1.BattleService/Ping';
/** OP_JOIN_BATTLE 是入局 op：重连后由 `replay` 配置的步骤重放。 */
export const OP_JOIN_BATTLE = '/battle.v1.BattleService/JoinBattle';
/** OP_SEND_FRAME_INPUT 是发帧 op（调用方按需经 Session.invoke 发送）。 */
export const OP_SEND_FRAME_INPUT = '/battle.v1.BattleService/SendFrameInput';
/** OP_SYNC_FRAMES 是补帧 op：载荷按 `frameNumberOf` 推进的补帧基准生成。 */
export const OP_SYNC_FRAMES = '/battle.v1.BattleService/SyncFrames';
/** OP_FRAME_BROADCAST 是帧广播推送的 op（会话据此推进补帧基准）。 */
export const OP_FRAME_BROADCAST = '/battle.v1.FrameBroadcast';
/** OP_BATTLE_END_NOTIFY 是战斗结束通知推送的 op（会话据此进入终态）。 */
export const OP_BATTLE_END_NOTIFY = '/battle.v1.BattleEndNotify';
/** OP_PLAYER_OUT_NOTIFY 是出局通知推送的 op（调用方订阅，会话本身不解释其载荷）。 */
export const OP_PLAYER_OUT_NOTIFY = '/battle.v1.PlayerOutNotify';
