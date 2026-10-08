// gamev1：game 玩家域（匹配链路）的 op 名——单一来源是模板仓 descriptor set 生成物
// （examples/gen/api/game/v1/player_service_pb.js，见 scripts/gen-dto.sh），
// 示例不写 op 字面量（与 gatewayv1.mjs 同口径）。
import {
  MatchFailedNotifySchema,
  MatchStartedNotifySchema,
  PlayerService,
} from './gen/api/game/v1/player_service_pb.js';

/** rpcOp 由生成的服务描述符推导客户端 op 全名（/包.服务/方法）。 */
const rpcOp = (service, method) => `/${service.typeName}/${service.method[method].name}`;

/** playerOps 匹配链路的客户端 op（入队/取消/查询状态）。 */
export const playerOps = {
  enterMatchQueue: rpcOp(PlayerService, 'enterMatchQueue'),
  cancelMatch: rpcOp(PlayerService, 'cancelMatch'),
  getMatchStatus: rpcOp(PlayerService, 'getMatchStatus'),
};

/** matchPushOps 匹配域推送 op（按消息完整名寻址）。 */
export const matchPushOps = {
  matchStartedNotify: `/${MatchStartedNotifySchema.typeName}`,
  matchFailedNotify: `/${MatchFailedNotifySchema.typeName}`,
};
