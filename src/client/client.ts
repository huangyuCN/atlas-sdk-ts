// Client：连接编排器（门面）。管理一条或多条通道（single/dual 形态）；
// Invoke/On 默认走业务通道，Channel(kind) 提供通道视图（生命周期归 Client，
// 视图不单独 Connect/Close）；State() 聚合向下降级。
import { Channel, Kind, type ChannelState } from './channel.js';
import type { NotifyHandler } from './notify.js';
import type { InvokeOption, Option } from './options.js';
import { supervise } from './reconnect.js';
import { transportHeartbeatLoop, sessionHeartbeatLoop } from './heartbeat.js';
import type { DialConfig, TransportDialer, TransportKind } from './transport.js';

/** Client 级聚合状态：任一通道非 Connected 即向下降级（细粒度走 Channel 视图）。 */
export type ClientState = ChannelState;

/** 单通道拨号配置。 */
export interface ChannelConfig {
  /** 传输类型（默认 tcp）。 */
  transport?: TransportKind;
  /** 服务端地址（host:port；WS 亦接受完整 ws:// URL）。 */
  addr: string;
  /** WS 服务端包装路径（空则 /ws）。 */
  path?: string;
  /** 本通道覆盖项（在全局 Option 之后应用；战斗通道可配短超时、每通道钩子）。 */
  opts?: Option[];
}

/** 状态劣化度：connected(0) < connecting/reconnecting(1) < disconnected(2)。 */
function stateSeverity(s: ClientState): number {
  if (s === 'connected') return 0;
  if (s === 'disconnected') return 2;
  return 1;
}

/** 通道视图：独立 Invoke/On/State；生命周期归 Client（不单独 Close）。 */
export class ChannelView {
  /** @internal 由 Client 构造。 */
  constructor(private readonly ch: Channel) {}

  invoke(op: string, req: unknown, ...opts: InvokeOption[]): Promise<unknown> {
    return this.ch.invoke(op, req, ...opts);
  }

  on(op: string, handler: NotifyHandler): () => void {
    return this.ch.on(op, handler);
  }

  state(): ChannelState {
    return this.ch.state;
  }

  get kind(): string {
    return this.ch.kind;
  }
}

export class Client {
  private readonly channels = new Map<string, Channel>();

  /** @internal 由 newClient / newDualClient 构造。 */
  addChannel(ch: Channel): void {
    this.channels.set(ch.kind, ch);
  }

  /** 请求-响应（默认业务通道）。 */
  invoke(op: string, req: unknown, ...opts: InvokeOption[]): Promise<unknown> {
    return this.business().invoke(op, req, ...opts);
  }

  /** 订阅推送（默认业务通道）。 */
  on(op: string, handler: NotifyHandler): () => void {
    return this.business().on(op, handler);
  }

  /** 通道视图（dual 形态区分业务/战斗；未知 kind 返回 null）。 */
  channel(kind: 'business' | 'battle'): ChannelView | null {
    const ch = this.channels.get(kind);
    return ch ? new ChannelView(ch) : null;
  }

  /** 聚合状态：任一通道取最劣（向下降级）。 */
  state(): ClientState {
    let worst: ClientState = 'connected';
    for (const ch of this.channels.values()) {
      const s = ch.state;
      if (stateSeverity(s) > stateSeverity(worst)) worst = s;
    }
    return worst;
  }

  /** 优雅关闭全部通道：取消全部 in-flight（NetworkError）、停止心跳与读循环。 */
  async close(): Promise<void> {
    await Promise.all([...this.channels.values()].map((ch) => ch.close()));
  }

  private business(): Channel {
    const ch = this.channels.get(Kind.Business);
    if (!ch) throw new Error('client: 业务通道不存在');
    return ch;
  }
}

/** 创建单通道 Client（等待首次连接成功；失败 reject 且停止——对齐 Dial 语义）。 */
export async function newClient(
  dialer: TransportDialer,
  cfg: DialConfig,
  kind: 'business' | 'battle',
  opts: readonly Option[],
): Promise<Client> {
  const ch = new Channel({ dialer, dialConfig: cfg, kind, opts });
  ch.internalDone = supervise(ch);
  const client = new Client();
  client.addChannel(ch);
  try {
    await ch.waitFirstConnect();
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}

/** 创建 dual 双通道 Client：业务 + 战斗通道独立心跳/重连/排队/钩子；
 * 自动链式重绑——业务通道重登成功后自动触发战斗通道钩子（Join 语义），
 * 战斗通道未就绪（未连接或已关闭）则跳过本轮。链式钩子追加在业务通道配置自身
 * （战斗通道按通道配置永不外溢）。 */
export async function newDualClient(
  dialer: TransportDialer,
  businessCfg: ChannelConfig,
  battleCfg: ChannelConfig,
  opts: readonly Option[],
): Promise<Client> {
  const battle = new Channel({
    dialer,
    dialConfig: dialConfigOf(battleCfg),
    kind: Kind.Battle,
    opts: [...opts, ...(battleCfg.opts ?? [])],
  });
  const business = new Channel({
    dialer,
    dialConfig: dialConfigOf(businessCfg),
    kind: Kind.Business,
    opts: [...opts, ...(businessCfg.opts ?? [])],
  });

  // 链式重绑：业务重登成功 → 战斗通道 Join 重绑（未就绪跳过本轮）。
  const battleHook = battle.settings.onReconnected;
  if (battleHook) {
    const userBusinessHook = business.settings.onReconnected;
    business.settings.onReconnected = async () => {
      if (userBusinessHook) await userBusinessHook();
      // 战斗通道未就绪（已关闭/未连接）：跳过本轮重绑，等战斗通道自身重连后由
      // 其钩子重绑。
      if (battle.closed || battle.state !== 'connected') return;
      await battleHook();
    };
  }

  battle.internalDone = supervise(battle);
  business.internalDone = supervise(business);
  const client = new Client();
  client.addChannel(battle);
  client.addChannel(business);
  try {
    await Promise.all([battle.waitFirstConnect(), business.waitFirstConnect()]);
  } catch (err) {
    await client.close();
    throw err;
  }
  return client;
}

function dialConfigOf(cfg: ChannelConfig): DialConfig {
  return {
    kind: cfg.transport ?? 'tcp',
    addr: cfg.addr,
    path: cfg.path,
  };
}

export { Kind };
