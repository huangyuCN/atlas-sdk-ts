// Session：会话生命周期管理器（与 Go client.Session 同构）——凭据保管、断线
// 自动恢复（Resume）、内置会话心跳与帧会话槽装配。业务请求经 Client.Invoke
// 发送（消息体不含身份字段），无连接传输（UDP/KCP）按帧会话槽携带凭据、
// 长连接（TCP/WS）按连接绑定。
//
// 协议来源（R13 / S0.5）：会话 op 名、请求字段与推送识别全部经 SessionProtocol
// 接缝取得（withSessionProtocol 接入，由项目侧生成的会话 stub 提供）。本文件
// **不 import 任何生成物、不含任何会话消息类型字面量**——回执解码由接缝实现承担，
// 项目必须提供并链接生成的会话 DTO（约束详见 sessionProtocol.ts 顶部说明）。
import type { Client } from './client.js';
import type { NotifyHandler } from './notify.js';
import { AtlasError } from './errors.js';
import {
  WithOnReconnected,
  WithSessionHeartbeat,
  WithSessionTokenProvider,
  type InvokeOption,
  type Option,
} from './options.js';
import type { PushEnvelope, SessionOps, SessionProtocol } from './sessionProtocol.js';
import { CLIENT_VERSION } from '../version.js';

/** 会话请求字段名约定（protojson 命名，与模板生成 DTO 字段一致）：SDK 自建的恢复
 * 请求按这些名字写字面量——名字集是接缝共约的请求侧约定，不构成对任何会话消息类型的
 * 依赖（本文件零生成物 import）。 */
const SESSION_FIELD_TOKEN = 'token';
const SESSION_FIELD_PLAYER_ID = 'playerId';
const SESSION_FIELD_CLIENT_VERSION = 'clientVersion';

/** SessionReplyUnresolvedError 表示会话回执解析不出关键凭据：接缝钩子从回执里取不到
 * 该 op 的关键字段（login → token；resume/restore → playerId）。典型原因：项目未提供/
 * 未链接生成的会话 DTO（提取器无处取字段）、接缝解码与载荷编码不匹配（ver=2 protobuf
 * 字节非自描述，须用生成 DTO 的 schema 解码）、服务端回执缺字段。
 *
 * 约束：项目二进制必须提供并链接生成的会话 DTO，并在其上实现接缝的 3 个提取钩子——
 * SDK 内核不认识任何会话消息类型，无法自行解码回执，故解析失败必须显式报错，
 * 不得返回「成功但 token 为空」。 */
export class SessionReplyUnresolvedError extends AtlasError {
  /** 出错的会话 op（接缝提供的 op 全名，如会话登录 op）。 */
  readonly op: string;
  /** 缺失的关键字段名（protojson 命名：token / playerId）。 */
  readonly field: string;

  constructor(op: string, field: string) {
    super(
      `session reply unresolved: op=${op} 缺少关键凭据 ${field}` +
        '（检查生成 DTO 是否已提供/链接、接缝解码是否匹配载荷编码）',
    );
    this.op = op;
    this.field = field;
  }
}

/** SessionSettings 是 Session 的配置全集（经 SessionOption 函数式覆盖）。 */
export interface SessionSettings {
  /** 会话协议接缝（withSessionProtocol 接入；未接入时会话方法显式报错）。 */
  protocol: SessionProtocol | null;
  /** 内置会话心跳周期；≤0 关闭（默认 30s，建议 ≤ 服务端会话租期/2）。 */
  heartbeatIntervalMs: number;
  /** 断线重连后自动恢复会话（默认开启）。 */
  autoResume: boolean;
  /** 自动恢复成功后的附加钩子（dual 形态战斗通道的 Join 重绑定另行配置）。 */
  resumeHook: (() => Promise<void> | void) | null;
}

/** SessionOption 配置 Session（函数式选项）。 */
export type SessionOption = (s: SessionSettings) => void;

/** WithSessionHeartbeatInterval 设置内置会话心跳周期（默认 30s；≤0 关闭）。
 * 心跳请求不携带 payload：服务端按连接（长连接）或帧会话槽（无连接）定位会话续租。 */
export function WithSessionHeartbeatInterval(intervalMs: number): SessionOption {
  return (s) => {
    s.heartbeatIntervalMs = intervalMs;
  };
}

/** WithAutoResume 设置断线重连后自动恢复会话（默认开启）：重连成功后以保存的
 * 凭据调 Resume；无凭据不算失败（登录由业务层重新发起），失败则继续退避重连。 */
export function WithAutoResume(enabled: boolean): SessionOption {
  return (s) => {
    s.autoResume = enabled;
  };
}

/** WithResumeHook 设置自动恢复成功后的附加钩子（dual 形态战斗通道的 Join 重绑定
 * 由用户在战斗通道 Option 里另行配置，与本钩子无关）。 */
export function WithResumeHook(fn: () => Promise<void> | void): SessionOption {
  return (s) => {
    s.resumeHook = fn;
  };
}

/** isPlainObject 判定字面量对象（@bufbuild 的 plain message 是其自有属性构成的
 * 字面量对象，同样命中；类实例不在此列）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** withClientVersion 在登录请求里补客户端版本（M1：网关按 client_version 做最低版本
 * 门槛判定；值取自 src/version.ts 单一来源）。字面量对象浅拷贝补字段；类实例等
 * 非字面量对象原样透传——拷贝会破坏其原型与序列化器识别，其 clientVersion 由调用方
 * 在 DTO 上设置。 */
function withClientVersion(req: unknown): unknown {
  if (req === null || req === undefined) return { [SESSION_FIELD_CLIENT_VERSION]: CLIENT_VERSION };
  if (!isPlainObject(req)) return req;
  return { ...req, [SESSION_FIELD_CLIENT_VERSION]: CLIENT_VERSION };
}

/** resumeRequest 构造恢复/接管请求（token + playerId + client_version）：SDK 自建请求
 * 无法引用生成 DTO 类型（状态机零会话消息类型），字段名集是接缝共约。 */
function resumeRequest(token: string, playerId: string): Record<string, unknown> {
  return {
    [SESSION_FIELD_TOKEN]: token,
    [SESSION_FIELD_PLAYER_ID]: playerId,
    [SESSION_FIELD_CLIENT_VERSION]: CLIENT_VERSION,
  };
}

/** Session 是会话生命周期管理器：凭据保管、断线自动恢复、内置会话心跳与帧
 * 会话槽装配。使用流程：newSession([withSessionProtocol(...)]) → bind(client)
 * （自动订阅被挤下线推送）→ login(req) 取回执凭据 → 业务 invoke（凭据按传输形态
 * 自动携带）。
 *
 * 回执按生成 DTO 形状返回（登录回执等）；非自描述编码（ver=2 protobuf）
 * 下序列化器返回原始字节，调用方按 schema 自解——与 Invoke 的既有分工一致。 */
export class Session {
  private cli: Client | null = null;
  private tokenValue = '';
  private playerIDValue = '';
  private kickedReasonValue = '';
  /** 推送订阅退订句柄（重绑/关闭时释放；订阅生命周期归 Session）。 */
  private offPush: (() => void) | null = null;
  private readonly settings: SessionSettings;

  /** @internal 由 newSession 构造。 */
  constructor(opts: readonly SessionOption[] = []) {
    this.settings = {
      protocol: null,
      heartbeatIntervalMs: 30_000,
      autoResume: true,
      resumeHook: null,
    };
    for (const o of opts) o(this.settings);
  }

  /** Bind 绑定 Client（必须先于 login/resume/logout 调用），并订阅全部推送：接缝按
   * 推送信封判定「被挤下线」，命中即记录原因并清空本地凭据（会话已失效）。
   * 重复绑定不累积订阅：重绑先退订旧 Client 的订阅。 */
  bind(cli: Client): void {
    this.requireProtocol();
    this.unsubscribe();
    this.cli = cli;
    this.offPush = cli.onAny(this.onPush);
  }

  /** Close 解绑并退订推送（幂等；不关闭 Client——其生命周期归调用方）。
   * 凭据保留（由 logout 或被踢清空），重新 bind 可继续使用。 */
  close(): void {
    this.unsubscribe();
    this.cli = null;
  }

  /** ChannelOptions 返回装配到业务通道的选项：会话凭据提供者（帧会话槽）、
   * 内置会话心跳与自动恢复钩子。在 Client 构造时传入。 */
  channelOptions(): Option[] {
    const opts: Option[] = [WithSessionTokenProvider(() => this.token())];
    if (this.settings.heartbeatIntervalMs > 0) {
      const heartbeatOp = this.ops().heartbeat;
      opts.push(
        WithSessionHeartbeat(this.settings.heartbeatIntervalMs, () => {
          if (this.token() === '') return null; // 未登录：跳过本轮
          return { op: heartbeatOp };
        }),
      );
    }
    if (this.settings.autoResume) {
      opts.push(WithOnReconnected(() => this.resumeHook()));
    }
    return opts;
  }

  /** Login 调用会话登录接口并保管回执凭据（req 为业务登录请求，如账号密码：
   * 生成的会话 DTO 或等价的字面量对象；客户端版本由本方法补入）。回执取不到 token
   * 抛 SessionReplyUnresolvedError（不静默成功）。 */
  async login(req?: unknown, ...invokeOpts: InvokeOption[]): Promise<unknown> {
    return this.callLogin(this.ops().login, withClientVersion(req), invokeOpts);
  }

  /** Register 调用注册接口（回执含 playerId；不建立会话、不保管凭据）。 */
  register(req?: unknown, ...invokeOpts: InvokeOption[]): Promise<unknown> {
    return this.invoke(this.ops().register, req, ...invokeOpts);
  }

  /** Resume 用保管中的凭据免密恢复会话（断线重连场景，复述客户端版本）；
   * 无凭据返回错误且不发网络请求。回执取不到 playerId 抛
   * SessionReplyUnresolvedError（模板恢复回执只回 playerId）。 */
  async resume(...invokeOpts: InvokeOption[]): Promise<unknown> {
    const op = this.ops().resume; // 先校验接缝已接入（未接入是接线错误，优先暴露）
    const token = this.token();
    if (token === '') {
      throw new Error('session: 无会话凭据（未登录）');
    }
    return this.callResume(op, resumeRequest(token, this.playerId()), invokeOpts);
  }

  /** Restore 用外部凭据恢复会话（成功后凭据由 Session 保管）：凭据来自上一代
   * 连接（如断线前快照），区别于 resume（用保管中的凭据）。 */
  async restore(
    token: string,
    playerId: string,
    ...invokeOpts: InvokeOption[]
  ): Promise<unknown> {
    if (token === '' || playerId === '') {
      throw new Error('session: 恢复凭据与玩家 ID 不能为空');
    }
    return this.callResume(this.ops().resume, resumeRequest(token, playerId), invokeOpts);
  }

  /** Heartbeat 手动触发一次会话心跳并返回对时回执（无载荷：服务端按连接/帧槽
   * 定位会话续租）；与内置定时心跳语义一致，未登录显式报错。 */
  async heartbeat(...invokeOpts: InvokeOption[]): Promise<unknown> {
    const op = this.ops().heartbeat; // 先校验接缝已接入（未接入是接线错误，优先暴露）
    if (this.token() === '') {
      throw new Error('session: 无会话凭据（未登录）');
    }
    return this.invoke(op, null, ...invokeOpts);
  }

  /** Logout 登出并清空本地凭据（无论请求成败都清空，对齐 Go 语义）。载荷为空消息
   * （模板登出请求无字段；序列化约定：null 跳过序列化发空 payload，
   * ver=1/ver=2 下服务端都解出空消息——不再复述已失效的 token）。 */
  async logout(...invokeOpts: InvokeOption[]): Promise<void> {
    const op = this.ops().logout; // 先校验接缝已接入
    try {
      await this.invoke(op, null, ...invokeOpts);
    } finally {
      this.clear();
    }
  }

  /** Invoke 发送业务请求（会话凭据已按传输形态自动携带，消息体不含身份字段）。 */
  invoke(op: string, req?: unknown, ...invokeOpts: InvokeOption[]): Promise<unknown> {
    return this.invokeWith(op, req, invokeOpts);
  }

  /** Token 返回当前会话凭据（未登录为空串）。 */
  token(): string {
    return this.tokenValue;
  }

  /** PlayerID 返回当前会话的玩家 ID（未登录为空串）。 */
  playerId(): string {
    return this.playerIDValue;
  }

  /** KickedReason 返回最近一次「被挤下线」推送的原因标识（接缝提取；未发生为空串）。
   * 凭据在收到推送时即被清空，本值供业务提示玩家（如「账号已在别处登录」）。 */
  kickedReason(): string {
    return this.kickedReasonValue;
  }

  /** onPush 是接缝驱动的推送处理：把帧分发的 (op, payload, version) 组装成推送信封
   * （S0.5 修订 1：version 决定载荷编码，接缝据此选解码器），接缝判定是否「被挤下线」，
   * 命中即记录原因并清空凭据；其余推送不影响会话状态。 */
  private readonly onPush: NotifyHandler = (op, payload, version) => {
    const envelope: PushEnvelope = { op, version, body: payload };
    const kicked = this.settings.protocol?.kicked(op, envelope);
    if (!kicked?.ok) return;
    this.kickedReasonValue = kicked.reason;
    this.clear();
  };

  /** clear 清空凭据（登出或会话失效）。 */
  private clear(): void {
    this.tokenValue = '';
    this.playerIDValue = '';
  }

  /** unsubscribe 释放推送退订句柄（幂等；重绑与关闭共用）。 */
  private unsubscribe(): void {
    this.offPush?.();
    this.offPush = null;
  }

  /** callLogin 发送登录请求并按**关键凭据**校验回执：token 为空即抛
   * SessionReplyUnresolvedError；凭据就位后覆盖本地值（对齐 Go Login 语义）。 */
  private async callLogin(
    op: string,
    req: unknown,
    invokeOpts: readonly InvokeOption[],
  ): Promise<unknown> {
    const protocol = this.requireProtocol();
    const reply = await this.invokeWith(op, req, invokeOpts);
    const token = protocol.token(reply);
    if (token === '') throw new SessionReplyUnresolvedError(op, SESSION_FIELD_TOKEN);
    this.tokenValue = token;
    this.playerIDValue = protocol.playerID(reply);
    this.kickedReasonValue = ''; // 新会话建立：上一次被挤下线的原因过期
    return reply;
  }

  /** callResume 发送恢复请求并按**关键凭据**校验回执：playerId 为空即抛
   * SessionReplyUnresolvedError；回执携带 token 时一并更新，否则沿用本地凭据
   * （模板恢复回执只回 playerId；expiresAt 钩子本轮无消费方，R13）。 */
  private async callResume(
    op: string,
    req: unknown,
    invokeOpts: readonly InvokeOption[],
  ): Promise<unknown> {
    const protocol = this.requireProtocol();
    const reply = await this.invokeWith(op, req, invokeOpts);
    const playerID = protocol.playerID(reply);
    if (playerID === '') throw new SessionReplyUnresolvedError(op, SESSION_FIELD_PLAYER_ID);
    this.playerIDValue = playerID;
    const token = protocol.token(reply);
    if (token !== '') this.tokenValue = token;
    this.kickedReasonValue = '';
    return reply;
  }

  /** resumeHook 是断线重连后的自动恢复钩子：无凭据（未登录即断连）不算失败，
   * 登录由业务层重新发起；有凭据则调 Resume，失败上抛（SDK 继续退避重连后再试）。 */
  private async resumeHook(): Promise<void> {
    if (this.token() === '') return;
    await this.resume();
    await this.settings.resumeHook?.();
  }

  /** invoke 委托业务通道 Invoke；cli 未绑定返回错误。 */
  private invokeWith(op: string, req: unknown, invokeOpts: readonly InvokeOption[]): Promise<unknown> {
    if (!this.cli) {
      return Promise.reject(new Error('session: 未绑定 Client'));
    }
    return this.cli.invoke(op, req, ...invokeOpts);
  }

  /** ops 返回接缝的会话 op 名集合（未接入接缝显式报错）。 */
  private ops(): SessionOps {
    return this.requireProtocol().ops();
  }

  /** requireProtocol 取会话协议接缝；未接入即报错（SDK 不留 gateway.v1 默认副本）。 */
  private requireProtocol(): SessionProtocol {
    if (!this.settings.protocol) {
      throw new Error('session: 未接入会话协议（withSessionProtocol）');
    }
    return this.settings.protocol;
  }
}

/** 创建会话管理器（经 withSessionProtocol 接入协议、bind 绑定 Client 后使用）。 */
export function newSession(opts: readonly SessionOption[] = []): Session {
  return new Session(opts);
}
