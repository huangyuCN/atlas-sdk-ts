// Session：会话生命周期管理器（与 Go client.Session 同构）——凭据保管、断线
// 自动恢复（Resume）、内置会话心跳与帧会话槽装配。业务请求经 Client.Invoke
// 发送（消息体不含身份字段），无连接传输（UDP/KCP）按帧会话槽携带凭据、
// 长连接（TCP/WS）按连接绑定。
import type { Client } from './client.js';
import type { NotifyHandler } from './notify.js';
import {
  WithOnReconnected,
  WithSessionHeartbeat,
  WithSessionTokenProvider,
  type InvokeOption,
  type Option,
} from './options.js';

// 会话生命周期接口的默认 operation（gateway.v1 收敛后的 Gateway 自留接口；
// 服务端 proto 重写后以此为准，可经 WithSessionOps 覆盖）。
/** OpSessionLogin 登录：凭账号信息建立会话，回执下发会话凭据。 */
export const OpSessionLogin = '/gateway.v1.Session/Login';
/** OpSessionRegister 注册（建立会话前的账号创建）。 */
export const OpSessionRegister = '/gateway.v1.Session/Register';
/** OpSessionResume 断线重连免密恢复会话（凭据从帧会话槽或请求体携带）。 */
export const OpSessionResume = '/gateway.v1.Session/Resume';
/** OpSessionLogout 登出（服务端清理会话）。 */
export const OpSessionLogout = '/gateway.v1.Session/Logout';
/** OpSessionHeartbeat 会话心跳（无 payload；服务端按连接/会话槽续租）。 */
export const OpSessionHeartbeat = '/gateway.v1.Session/Heartbeat';
/** OpSessionKickedNotify 是被挤下线推送的 operation（服务端 Notify 帧按消息名寻址）。 */
export const OpSessionKickedNotify = '/gateway.v1.KickedNotify';

/** SessionReply 是会话生命周期接口的统一回执形状（协议约定：gateway.v1 会话
 * 消息，JSON 字段名 lowerCamel）；业务也可用自身 DTO 经序列化器解析。 */
export interface SessionReply {
  playerId?: string;
  token?: string;
}

/** ResumeReq 是会话恢复请求（凭据放请求体；长连接场景服务端亦按连接绑定校验）。 */
export interface ResumeReq {
  token?: string;
}

/** LogoutReq 是登出请求。 */
export interface LogoutReq {
  token?: string;
}

/** SessionOps 是会话生命周期 op 名集合（默认见 OpSession* 常量；可整体覆盖）。 */
export interface SessionOps {
  login: string;
  register: string;
  resume: string;
  logout: string;
  heartbeat: string;
}

/** DefaultSessionOps 返回默认会话 op 集。 */
export function defaultSessionOps(): SessionOps {
  return {
    login: OpSessionLogin,
    register: OpSessionRegister,
    resume: OpSessionResume,
    logout: OpSessionLogout,
    heartbeat: OpSessionHeartbeat,
  };
}

/** SessionSettings 是 Session 的配置全集（经 SessionOption 函数式覆盖）。 */
export interface SessionSettings {
  /** 会话生命周期 op 名集合。 */
  ops: SessionOps;
  /** 内置会话心跳周期；≤0 关闭（默认 30s，建议 ≤ 服务端会话租期/2）。 */
  heartbeatIntervalMs: number;
  /** 断线重连后自动恢复会话（默认开启）。 */
  autoResume: boolean;
  /** 自动恢复成功后的附加钩子（dual 形态战斗通道的 Join 重绑定另行配置）。 */
  resumeHook: (() => Promise<void> | void) | null;
}

/** SessionOption 配置 Session（函数式选项）。 */
export type SessionOption = (s: SessionSettings) => void;

/** WithSessionOps 覆盖会话生命周期 op 名（服务端 op 约定不一致时使用）。 */
export function WithSessionOps(ops: SessionOps): SessionOption {
  return (s) => {
    s.ops = ops;
  };
}

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

/** Session 是会话生命周期管理器：凭据保管、断线自动恢复、内置会话心跳与帧
 * 会话槽装配。使用流程：newSession(...) → bind(client)（自动订阅被挤下线推送）
 * → login(req) 取回执凭据 → 业务 invoke（凭据按传输形态自动携带）。 */
export class Session {
  private cli: Client | null = null;
  private tokenValue = '';
  private playerIDValue = '';
  private readonly settings: SessionSettings;

  /** @internal 由 newSession 构造。 */
  constructor(opts: readonly SessionOption[] = []) {
    this.settings = {
      ops: defaultSessionOps(),
      heartbeatIntervalMs: 30_000,
      autoResume: true,
      resumeHook: null,
    };
    for (const o of opts) o(this.settings);
  }

  /** Bind 绑定 Client（必须先于 login/resume/logout 调用），并自动订阅被挤下线
   * 推送：收到即清空本地凭据（会话已失效）。 */
  bind(cli: Client): void {
    this.cli = cli;
    cli.on(OpSessionKickedNotify, this.onKicked);
  }

  /** ChannelOptions 返回装配到业务通道的选项：会话凭据提供者（帧会话槽）、
   * 内置会话心跳与自动恢复钩子。在 Client 构造时传入。 */
  channelOptions(): Option[] {
    const opts: Option[] = [WithSessionTokenProvider(() => this.token())];
    if (this.settings.heartbeatIntervalMs > 0) {
      const heartbeatOp = this.settings.ops.heartbeat;
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

  /** Login 调用会话登录接口并保管回执凭据（req 为业务登录请求，如账号密码）。 */
  async login(req?: unknown, ...invokeOpts: InvokeOption[]): Promise<SessionReply> {
    return this.call(this.settings.ops.login, req, invokeOpts);
  }

  /** Register 调用注册接口（回执含 playerId；不建立会话、不保管凭据）。 */
  async register(req?: unknown, ...invokeOpts: InvokeOption[]): Promise<SessionReply> {
    return this.invoke(this.settings.ops.register, req, ...invokeOpts) as Promise<SessionReply>;
  }

  /** Resume 用保管中的凭据免密恢复会话（断线重连场景）；无凭据返回错误且不发
   * 网络请求。 */
  async resume(...invokeOpts: InvokeOption[]): Promise<SessionReply> {
    const token = this.token();
    if (token === '') {
      throw new Error('session: 无会话凭据（未登录）');
    }
    return this.call(this.settings.ops.resume, { token } satisfies ResumeReq, invokeOpts);
  }

  /** Logout 登出并清空本地凭据（无论请求成败都清空，对齐 Go 语义）。 */
  async logout(...invokeOpts: InvokeOption[]): Promise<void> {
    const token = this.token();
    await this.invoke(
      this.settings.ops.logout,
      { token } satisfies LogoutReq,
      ...invokeOpts,
    );
    this.clear();
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

  /** Kicked 推送处理：清空凭据（会话已失效）。 */
  private readonly onKicked: NotifyHandler = () => {
    this.clear();
  };

  /** clear 清空凭据（登出或会话失效）。 */
  private clear(): void {
    this.tokenValue = '';
    this.playerIDValue = '';
  }

  /** call 调用会话接口并在成功后保管回执凭据。 */
  private async call(op: string, req: unknown, invokeOpts: readonly InvokeOption[]): Promise<SessionReply> {
    const reply = (await this.invokeWith(op, req, invokeOpts)) as SessionReply | null;
    this.tokenValue = reply?.token ?? '';
    this.playerIDValue = reply?.playerId ?? '';
    return reply ?? {};
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
}

/** 创建会话管理器（经 bind 绑定 Client 后使用）。 */
export function newSession(opts: readonly SessionOption[] = []): Session {
  return new Session(opts);
}
