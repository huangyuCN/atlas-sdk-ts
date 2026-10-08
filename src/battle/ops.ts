// 战斗域 op 与推送 op 的默认取值（纯路由键：推送/调用按消息完整名寻址，不是魔法值）。
// 取值与模板生成 stub（api/client/ts/api/battle/v1/opclient/battle_service_pb.ts 的
// BattleServiceProtocolOps / battleServicePushOps）同源；调用方可用 opts.ops 覆盖
// （SDK 不强制项目侧接受这份默认值）。

/** BattleOps 战斗域客户端 op（请求-响应/单向调用）。 */
export const BattleOps = {
  joinBattle: '/battle.v1.BattleService/JoinBattle',
  sendFrameInput: '/battle.v1.BattleService/SendFrameInput',
  syncFrames: '/battle.v1.BattleService/SyncFrames',
  /** 直连保活探针（Tell，无回执）：无输入期间周期发送，维持帧面活跃。 */
  ping: '/battle.v1.BattleService/Ping',
} as const;

/** BattlePushOps 战斗域直连推送 op（帧广播 / 战斗结束）。 */
export const BattlePushOps = {
  frameBroadcast: '/battle.v1.FrameBroadcast',
  battleEndNotify: '/battle.v1.BattleEndNotify',
} as const;

/** BattleOpSet 是一次直连会话用到的全部 op 名（战斗 op + 推送 op）。 */
export interface BattleOpSet {
  joinBattle: string;
  sendFrameInput: string;
  syncFrames: string;
  ping: string;
  frameBroadcast: string;
  battleEndNotify: string;
}

/** DEFAULT_BATTLE_OPS 默认 op 集合（battle.v1 契约）。 */
export const DEFAULT_BATTLE_OPS: BattleOpSet = {
  ...BattleOps,
  ...BattlePushOps,
};
