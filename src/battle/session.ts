// 战斗直连会话（TS：浏览器只有 WS 面）：成局推送给「票据 + 接入层 WS 面地址」，SDK 向
// 该地址发起 WS 升级（票走 query `?ticket=`），升级后每个战斗帧的会话槽带同一张票。
// 帧格式与既有 WS 通道**完全一致**——只多「升级带票 + 逐帧带票」两件事，其余全部复用
// 本仓既有实现：dialWebSocket（传输 + 升级 URL 拼装）、buildRequestBodyFull（段序
// operation → 会话槽 → 幂等键 → 载荷）、decodeFrame/decodeReply/parseRequestBody（收帧）、
// 错误四分类与 backoffDelay/sleepInterruptible（退避）。
//
// 错误分类（规格 §7，判定入口见 src/battle/errors.ts）：
//   - 接入层拒连（升级阶段被断 / 升级后无任何回执即被断 / 重连窗口用尽）→
//     NetworkError(retryable=false)：**不重试**，上层回业务链路重新取票；
//   - 会话建立后的网络断开 → NetworkError(retryable=true)：退避自动重连（同一张票，
//     窗口 reconnectWindowMs 内；对齐 battle 侧 offline_timeout 的「窗口内可回座」）；
//   - 票过期/无效（battle 侧结构化拒绝）→ BusinessError（reason BATTLE_TICKET_*）；
//   - 帧/包络非法 → ProtocolError：终止，不重连（失步连接不可再用）。
import type { InvokeOption, InvokeOptions } from '../client/options.js';
import type { PendingOutcome } from '../client/channelTypes.js';
import type { ChannelTransport } from '../client/transport.js';
import { BusinessError, NetworkError, ProtocolError, TimeoutError } from '../client/errors.js';
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';
import { backoffDelay, sleepInterruptible } from '../client/reconnect.js';
import { serializerVersion } from '../client/serializer.js';
import { newRequestId } from '../client/channelUtil.js';
import { buildRequestBodyFull, parseRequestBody } from '../frame/body.js';
import { FLAG_REQUEST_ID, FLAG_SESSION, MAGIC, MsgType, type Header } from '../frame/constants.js';
import { decodeReply } from '../frame/reply.js';
import { dialWebSocket } from '../transport/ws.js';
import {
  resolveSettings,
  type BattleSession,
  type BattleSessionOptions,
  type BattleSessionState,
  type Settings,
} from './contract.js';
import { EdgeTransport, type DirectPlan } from './plan.js';
import { BattleHeartbeat } from './heartbeat.js';
import { ticketSlotValue } from './ticket.js';
import { edgeRejectedError } from './errors.js';
import { classifyExit, classifyWriteError, frameIdOfProtojson, syncRequest, withBattleId } from './wire.js';

export type { BattleSession, BattleSessionOptions, BattleSessionState } from './contract.js';

/** Pending 一条请求的等待项（超时兜底；结算恰一次）。 */
interface Pending {
  timer: ReturnType<typeof setTimeout>;
  settle: (outcome: PendingOutcome) => void;
}

/** Phase 一次建连尝试的阶段（升级 vs 升级后的入局/补帧恢复）。 */
type Phase = 'dial' | 'restore';

/** DirectBattleSession 是 BattleSession 的实现（经 openBattleSession 构造）。 */
class DirectBattleSession implements BattleSession {
  readonly matchId: string;
  readonly battleId: string;
  readonly address: string;
  private readonly settings: Settings;
  private readonly ticket: Uint8Array;
  private readonly slot: string;
  private readonly ver: number;
  private readonly pending = new Map<number, Pending>();
  private readonly closeSignal: Promise<void>;
  private signalClose!: () => void;
  private readonly heartbeat: BattleHeartbeat;
  private transport: ChannelTransport | null = null;
  private current: BattleSessionState = 'connecting';
  private seq = 0;
  private lastFrame = 0;
  private receivedAny = false;
  private connecting = false;
  private joined = false;
  private restoring = false;
  private closing = false;
  private reconnectTask: Promise<void> | null = null;

  constructor(plan: DirectPlan, opts: BattleSessionOptions) {
    this.settings = resolveSettings(opts);
    this.matchId = plan.matchId;
    this.battleId = plan.battleId;
    const address = plan.endpoints.get(EdgeTransport.Ws);
    if (address === undefined) {
      throw new ProtocolError(`battle: 上线包缺 ${EdgeTransport.Ws} 面地址`);
    }
    this.address = address;
    this.ticket = plan.ticket;
    this.slot = ticketSlotValue(plan.ticket);
    this.ver = serializerVersion(this.settings.serializer);
    this.heartbeat = new BattleHeartbeat({
      periodMs: this.settings.heartbeatMs,
      beat: () => this.sendHeartbeat(),
      onError: (err) => this.reportHeartbeatFailure(err),
    });
    this.closeSignal = new Promise<void>((resolve) => {
      this.signalClose = resolve;
    });
  }

  state(): BattleSessionState {
    return this.current;
  }

  lastSeenFrame(): number {
    return this.lastFrame;
  }

  noteFrame(frameId: number): void {
    if (Number.isInteger(frameId) && frameId > this.lastFrame) this.lastFrame = frameId;
  }

  async joinBattle(req?: unknown, ...opts: InvokeOption[]): Promise<unknown> {
    this.requireReady();
    const reply = await this.call(this.settings.ops.joinBattle, withBattleId(this.battleId, req), opts);
    this.joined = true;
    return reply;
  }

  async sendFrameInput(req?: unknown, ...opts: InvokeOption[]): Promise<unknown> {
    this.requireReady();
    return this.call(this.settings.ops.sendFrameInput, withBattleId(this.battleId, req), opts);
  }

  async syncFrames(lastSeenFrame: number = this.lastFrame, ...opts: InvokeOption[]): Promise<unknown> {
    this.requireReady();
    return this.call(this.settings.ops.syncFrames, syncRequest(this.battleId, lastSeenFrame), opts);
  }

  /** reconnect 重新升级并恢复入局状态：已连接时幂等；并发调用共享同一轮尝试。 */
  reconnect(): Promise<void> {
    if (this.closing || this.current === 'closed') {
      return Promise.reject(new NetworkError('战斗直连会话已关闭'));
    }
    if (this.current === 'connected' && this.transport !== null) return Promise.resolve();
    if (this.reconnectTask === null) {
      this.setState('reconnecting');
      this.reconnectTask = this.connectOnce(true).finally(() => {
        this.reconnectTask = null;
      });
    }
    return this.reconnectTask;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.heartbeat.stop();
    this.signalClose();
    this.setState('closed');
    const tr = this.transport;
    this.transport = null;
    this.failPending(new NetworkError('战斗直连会话已关闭'));
    if (tr !== null) await tr.close().catch(() => {});
  }

  /** open 首次建连（autoJoin 时在本次尝试内完成 JoinBattle）。 */
  async open(): Promise<void> {
    this.joined = this.settings.autoJoin;
    this.setState('connecting');
    await this.connectOnce(false);
  }

  /** connectOnce 建连一轮（connecting 置位期间读循环死亡由本轮归类，不另起重连）。 */
  private async connectOnce(isReconnect: boolean): Promise<void> {
    this.connecting = true;
    try {
      await this.connectLoop(isReconnect);
    } finally {
      this.connecting = false;
    }
  }

  /** connectLoop 建连主循环：拨号（升级带票）→ 恢复入局状态。
   *  重连场景在 reconnectWindowMs 窗口内对网络类失败退避重试；首连失败与
   *  业务拒绝/协议错误立即上抛（分类见 classifyFailure）。 */
  private async connectLoop(isReconnect: boolean): Promise<void> {
    const deadline = Date.now() + this.settings.reconnectWindowMs;
    let attempt = 0;
    for (;;) {
      let tr: ChannelTransport | null = null;
      let phase: Phase = 'dial';
      this.receivedAny = false;
      try {
        tr = await this.dial();
        phase = 'restore';
        this.install(tr);
        await this.restore(isReconnect);
        if (this.transport !== tr) throw new NetworkError('战斗直连在建立后立即断开');
        this.setState('connected');
        this.heartbeat.start(); // 保活心跳随本代连接启动（换代/关闭即停）
        if (isReconnect) await this.settings.onReconnected?.();
        return;
      } catch (err) {
        if (tr !== null) await this.closeTransport(tr);
        if (!this.canRetry(isReconnect, err, deadline)) throw this.classifyFailure(phase, err);
        attempt += 1;
        const wait = backoffDelay(this.settings.backoffBaseMs, this.settings.backoffMaxMs, attempt);
        if (!(await sleepInterruptible(wait, this.closeSignal))) return; // 关闭打断
      }
    }
  }

  /** canRetry 判定是否在重连窗口内继续尝试：业务拒绝/协议错误/已判拒连一律不重试。 */
  private canRetry(isReconnect: boolean, err: unknown, deadline: number): boolean {
    if (!isReconnect || this.closing || Date.now() >= deadline) return false;
    if (err instanceof BusinessError || err instanceof ProtocolError) return false;
    if (err instanceof FrameProtocolError) return false;
    if (err instanceof NetworkError && !err.retryable) return false;
    return true;
  }

  /** classifyFailure 归类建连失败：票类业务拒绝与协议错误原样上抛（可判定）；
   *  升级阶段被断、或升级后未收到任何回执即被断 → 接入层拒连（不可重试）。 */
  private classifyFailure(phase: Phase, err: unknown): unknown {
    if (err instanceof BusinessError || err instanceof ProtocolError || err instanceof FrameProtocolError) {
      return err;
    }
    if (err instanceof NetworkError && !err.retryable) return err;
    if (phase === 'restore' && this.receivedAny) return err; // 已有回执：按网络断开（可重试语义）
    if (err instanceof NetworkError) {
      const why = phase === 'dial' ? '升级阶段被断开' : '升级后无回执即被断开';
      return edgeRejectedError(`战斗直连接入层拒连（${why}）：票可能已失效，请回业务链路重新取票`, err);
    }
    return err; // TimeoutError 等：原样上抛
  }

  /** dial 拨号接入层 WS 面：升级 URL 带票（base64url），路径取配置（默认 /）。 */
  private dial(): Promise<ChannelTransport> {
    return dialWebSocket(
      { kind: 'ws', addr: this.address, path: this.settings.path, ticket: this.ticket },
      { wsFactory: this.settings.wsFactory, openTimeoutMs: this.settings.openTimeoutMs },
    );
  }

  /** install 接管一条新连接：登记为当前代并启动读循环。 */
  private install(tr: ChannelTransport): void {
    this.transport = tr;
    this.startRead(tr);
  }

  /** restore 恢复入局状态：曾入局则重新 JoinBattle；重连额外用 SyncFrames 补帧。 */
  private async restore(isReconnect: boolean): Promise<void> {
    if (!this.joined) return;
    this.restoring = true;
    try {
      await this.call(this.settings.ops.joinBattle, { battleId: this.battleId }, []);
      if (isReconnect) await this.call(this.settings.ops.syncFrames, syncRequest(this.battleId, this.lastFrame), []);
    } finally {
      this.restoring = false;
    }
  }

  private startRead(tr: ChannelTransport): void {
    void (async () => {
      let exitErr: unknown = null;
      try {
        exitErr = await this.readFrames(tr);
      } catch (err) {
        exitErr = err;
      }
      this.onClosed(tr, exitErr);
    })();
  }

  /** readFrames 读循环：Response 按 seq 结算、Notify 分发；其余帧类型协议致命。 */
  private async readFrames(tr: ChannelTransport): Promise<unknown> {
    for (;;) {
      const f = await tr.readFrame(this.settings.maxBodySize);
      this.receivedAny = true;
      if (f.header.type === MsgType.Response) {
        const fatal = this.onResponse(f.header, f.body);
        if (fatal !== null) return fatal;
      } else if (f.header.type === MsgType.Notify) {
        this.onNotify(f.header, f.body);
      } else {
        return new ProtocolError(`战斗直连收到非法帧类型 ${f.header.type}`);
      }
    }
  }

  /** onResponse 校验响应版本并结算 in-flight；包络非法返回协议致命错误。 */
  private onResponse(hdr: Header, body: Uint8Array): ProtocolError | null {
    if (hdr.version !== this.ver) {
      return new ProtocolError(`响应帧 version ${hdr.version} 与载荷编码 ${this.ver} 不一致`);
    }
    let reply;
    try {
      reply = decodeReply(body);
    } catch (err) {
      return new ProtocolError('响应包络非法', err);
    }
    this.settle(
      hdr.seq,
      reply.status !== null ? { kind: 'status', status: reply.status } : { kind: 'data', data: reply.data },
    );
    return null;
  }

  /** onNotify 解析推送 body 并分发；坏帧静默丢弃（推送不参与请求匹配）。 */
  private onNotify(hdr: Header, body: Uint8Array): void {
    try {
      const { operation, payload } = parseRequestBody(body);
      this.handlePush(operation, payload, hdr.version);
    } catch {
      // 静默丢弃
    }
  }

  /** handlePush 按 op 分发推送回调（回调异常隔离：不影响读循环）。
   *  帧号先于 onFrame 推进（回调抛异常也不丢补帧进度）。 */
  private handlePush(op: string, payload: Uint8Array, version: number): void {
    try {
      if (op === this.settings.ops.frameBroadcast) {
        this.noteFrame(this.extractFrameId(payload, version));
        this.settings.onFrame?.(payload, version);
      } else if (op === this.settings.ops.battleEndNotify) {
        this.settings.onBattleEnd?.(payload, version);
      }
      this.settings.onPush?.(op, payload, version);
    } catch {
      // 业务回调异常不影响读循环
    }
  }

  /** extractFrameId 提取帧广播的帧号：默认只解 ver=1（protojson）的 frame.frameId；
   *  ver=2 二进制非自描述，未提供钩子时返回 -1（不猜编码，仅不推进补帧进度）。 */
  private extractFrameId(payload: Uint8Array, version: number): number {
    const custom = this.settings.frameNumberOf;
    if (custom !== undefined) return custom(payload, version);
    if (version !== 1) return -1;
    return frameIdOfProtojson(payload);
  }

  /** onClosed 连接死亡：回收 in-flight，并按错误分类决定重连或终止。 */
  private onClosed(tr: ChannelTransport, err: unknown): void {
    if (this.transport !== tr) return; // 陈旧代（本地关闭/主动弃用）：不触发重连
    this.transport = null;
    this.heartbeat.stop(); // 本代死亡即停心跳（不泄漏；重连成功后按新代再启）
    const failure = classifyExit(err);
    this.failPending(failure);
    if (this.closing || this.connecting) return; // 建连中：由 connectOnce 归类与重试
    if (failure instanceof ProtocolError || !this.settings.autoReconnect) {
      this.fail(failure);
      return;
    }
    this.setState('reconnecting');
    void this.reconnect().catch((e: unknown) => this.fail(e));
  }

  /** fail 置失败态并通知（不重连：协议致命/自动重连关闭/重连窗口用尽）。 */
  private fail(err: unknown): void {
    this.setState('failed');
    try {
      this.settings.onFailed?.(err);
    } catch {
      // 回调异常隔离
    }
  }

  /** call 发送一次请求并等待结算（不排队：未就绪即报错，由调用方决定重发）。 */
  private async call(op: string, req: unknown, invokeOpts: readonly InvokeOption[]): Promise<unknown> {
    const tr = this.transport;
    if (tr === null) throw new NetworkError('战斗直连未建立');
    const io: InvokeOptions = { failFast: true };
    for (const o of invokeOpts) o(io);
    const seq = ++this.seq;
    const payload = req === null || req === undefined ? new Uint8Array(0) : this.settings.serializer.marshal(req);
    const requestId = io.noIdempotency ? '' : (io.idempotencyKey ?? newRequestId());
    const body = buildRequestBodyFull(op, this.slot, requestId, payload);
    const outcome = this.registerPending(seq, op, io.timeoutMs ?? this.settings.invokeTimeoutMs);
    const header: Header = {
      magic: MAGIC,
      version: this.ver,
      type: MsgType.Request,
      flags: FLAG_SESSION | (requestId === '' ? 0 : FLAG_REQUEST_ID),
      seq,
      length: body.length,
    };
    try {
      await tr.writeFrame(header, body, this.settings.maxBodySize);
    } catch (err) {
      this.settle(seq, { kind: 'error', error: classifyWriteError(err) });
    }
    return this.unwrap(await outcome);
  }

  /** sendHeartbeat 一拍保活：Tell 语义——带会话槽票、不带幂等键、不登记 pending
   *（回执若到由 settle 静默丢弃，不占待结算表）；未就绪/恢复入局中跳过本轮，
   *  避免与建连、补帧抢跑。发送失败由 BattleHeartbeat 归口到 onHeartbeatFailed。 */
  private async sendHeartbeat(): Promise<void> {
    const tr = this.transport;
    if (tr === null || this.closing || this.restoring || this.current !== 'connected') return;
    const payload = this.settings.serializer.marshal(withBattleId(this.battleId, undefined));
    const body = buildRequestBodyFull(this.settings.ops.ping, this.slot, '', payload);
    const header: Header = {
      magic: MAGIC,
      version: this.ver,
      type: MsgType.Request,
      flags: FLAG_SESSION,
      seq: ++this.seq,
      length: body.length,
    };
    await tr.writeFrame(header, body, this.settings.maxBodySize);
  }

  /** reportHeartbeatFailure 心跳失败只上报（回调异常隔离）：不改会话状态、不终止会话。 */
  private reportHeartbeatFailure(err: unknown): void {
    try {
      this.settings.onHeartbeatFailed?.(err);
    } catch {
      // 回调异常不影响心跳循环
    }
  }

  private registerPending(seq: number, op: string, timeoutMs: number): Promise<PendingOutcome> {
    return new Promise<PendingOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(seq, { kind: 'error', error: new TimeoutError(op, timeoutMs) });
      }, timeoutMs);
      this.pending.set(seq, { timer, settle: resolve });
    });
  }

  /** settle 结算一条请求（查表恰一次：迟到结果静默丢弃）。 */
  private settle(seq: number, outcome: PendingOutcome): void {
    const entry = this.pending.get(seq);
    if (entry === undefined) return;
    this.pending.delete(seq);
    clearTimeout(entry.timer);
    entry.settle(outcome);
  }

  private failPending(err: NetworkError | ProtocolError): void {
    for (const [seq] of [...this.pending]) {
      this.settle(seq, { kind: 'error', error: err });
    }
  }

  /** unwrap 归类结算结果：业务拒绝抛 BusinessError，错误原样上抛，数据交序列化器。 */
  private unwrap(outcome: PendingOutcome): unknown {
    if (outcome.kind === 'status') {
      throw new BusinessError(
        outcome.status.code,
        outcome.status.reason,
        outcome.status.message,
        outcome.status.metadata,
        outcome.status.class,
      );
    }
    if (outcome.kind === 'error') throw outcome.error;
    return this.settings.serializer.unmarshal(outcome.data, null);
  }

  private async closeTransport(tr: ChannelTransport): Promise<void> {
    if (this.transport === tr) this.transport = null;
    await tr.close().catch(() => {});
  }

  /** requireReady 外部调用前置校验：未就绪即报错（不排队）。 */
  private requireReady(): void {
    if (this.closing || this.current === 'closed') throw new NetworkError('战斗直连会话已关闭');
    if (this.transport === null || this.restoring) {
      throw new NetworkError(`战斗直连未就绪（${this.current}）`);
    }
  }

  private setState(s: BattleSessionState): void {
    this.current = s;
  }
}

/** openBattleSession 打开一条战斗直连会话：升级带票 → （默认）JoinBattle；
 *  失败时关闭半开连接并把可判定错误上抛（票过期/接入层拒连由上层决定回退）。 */
export async function openBattleSession(
  plan: DirectPlan,
  opts: BattleSessionOptions = {},
): Promise<BattleSession> {
  const session = new DirectBattleSession(plan, opts);
  try {
    await session.open();
  } catch (err) {
    await session.close();
    throw err;
  }
  return session;
}
