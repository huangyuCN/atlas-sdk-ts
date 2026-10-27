// gamev1：game 玩家域（匹配链路）的 op 名——**示例侧字面量**。
//
// 游戏域消息（battle / game / matcher 的 DTO 与 op 常量）已迁出 SDK，改由游戏自己的协议包
// （模板仓 protocol/）按 .proto 生成。本仓示例刻意不依赖协议包（CI 检出位置与本地路径不一致，
// 且协议包 README 明定 SDK 不依赖它），故在此写出这些**寻址键**的字面量；真实项目请直接用
// 协议包生成的 op 常量与 DTO——SDK 只负责按 op 发字节、把回执原样交回，不解游戏消息。

/** playerOps 匹配链路的客户端 op（入队/取消/查询状态）。 */
export const playerOps = {
  enterMatchQueue: '/game.v1.PlayerService/EnterMatchQueue',
  cancelMatch: '/game.v1.PlayerService/CancelMatch',
  getMatchStatus: '/game.v1.PlayerService/GetMatchStatus',
};

/** matchPushOps 匹配域推送 op（按消息完整名寻址）。 */
export const matchPushOps = {
  matchStartedNotify: '/game.v1.MatchStartedNotify',
  matchFailedNotify: '/game.v1.MatchFailedNotify',
};
