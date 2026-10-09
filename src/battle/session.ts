// 战斗直连会话（TS：浏览器只有 WS 面）：成局推送给「票据 + 接入层 WS 面地址」，SDK 向
// 该地址发起 WS 升级（票走 query `?ticket=`），升级后每个战斗帧的会话槽带同一张票。
// 帧格式与既有 WS 通道**完全一致**——只多「升级带票 + 逐帧带票」两件事，其余全部复用
// 本仓既有实现：dialWebSocket（传输 + 升级 URL 拼装）、buildRequestBodyFull（段序
// operation → 会话槽 → 幂等键 → 载荷）、decodeFrame/decodeReply/parseRequestBody（收帧）、
// 错误四分类与 backoffDelay/sleepInterruptible（退避）。收帧面见 src/battle/inbound.ts，
// 待结算表见 pending.ts，运行统计见 stats.ts。
//
// 错误分类的判定入口见 src/battle/errors.ts（接入层拒连 = 不可重试的 NetworkError、
// 票类拒绝与「对局已结束」= BusinessError、帧/包络非法 = ProtocolError）。本文件额外维护
// **两类终态**，都不可逆、都不再写线：
//   1. 对局结束（ending.ts 收口）：停发一切上发，只在收尾窗口内继续收结果；
//   2. 会话无用（终态族里的「对局不存在/已满/目标不一致」）：停发 + 释放连接 + 上报失败。
// 并发要点（评审 P0-7）：拨号结果按**代次**作废——close() 递增代次，拨号返回后先复查
// 代次与关闭标记再安装；作废即关闭该 socket，不安装通道、不写线（对齐 Go 的 generation 复查）。
import type { InvokeOption, InvokeOptions } from '../client/options.js';
import type { PendingOutcome } from '../client/channelTypes.js';
import type { ChannelTransport } from '../client/transport.js';
import { BusinessError, NetworkError, ProtocolError } from '../client/errors.js';
import { backoffDelay, sleepInterruptible } from '../client/reconnect.js';
import { serializerVersion } from '../client/serializer.js';
import { newRequestId } from '../client/channelUtil.js';
import { buildRequestBodyFull } from '../frame/body.js';
import { FLAG_REQUEST_ID, FLAG_SESSION, MAGIC, MsgType, type Header } from '../frame/constants.js';
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
import { BattleEnding } from './ending.js';
import { BattleInbound } from './inbound.js';
import { PendingTable } from './pending.js';
import { BattleStats, type BattleSessionStats } from './stats.js';
import { BattleTerminal } from './terminal.js';
import { ticketSlotValue } from './ticket.js';
import { battleEndedError, battleEndedStatus, businessErrorOf } from './errors.js';
import {
  canRetry,
  classifyExit,
  classifyFailure,
  classifyWriteError,
  safeCall,
  syncRequest,
  withBattleId,
  type ConnectPhase,
} from './wire.js';

export type { BattleSession, BattleSessionOptions, BattleSessionState } from './contract.js';
export type { BattleSessionStats } from './stats.js';

/** HEARTBEAT_TRACK 在途心跳记账上限（拍）：心跳是 Tell（无 pending），但回执可能带业务
 *  拒绝——只保留最近若干拍即可覆盖一个 RTT 内的回执，又不让账无界增长。 */
const HEARTBEAT_TRACK = 8;

/** DirectBattleSession 是 BattleSession 的实现（经 openBattleSession 构造）。 */
class DirectBattleSession implements BattleSession {
  readonly matchId: string;
  readonly battleId: string;
  readonly address: string;
  private readonly settings: Settings;
  private readonly ticket: Uint8Array;
  private readonly slot: string;
  private readonly ver: number;
  private readonly pending = new PendingTable();
  private readonly counters = new BattleStats();
  private readonly inbound: BattleInbound;
  private readonly closeSignal: Promise<void>;
  private signalClose!: () => void;
  private readonly heartbeat: BattleHeartbeat;
  private readonly ending: BattleEnding;
  private transport: ChannelTransport | null = null;
  private current: BattleSessionState = 'connecting';
  private seq = 0;
  private connecting = false;
  private joined = false;
  private restoring = false;
  private closing = false;
  private reconnectTask: Promise<void> | null = null;
  /** generation 连接代次：close() 递增，拨号返回后按它复查（P0-7 的作废依据）。 */
  private generation = 0;
  /** heartbeats 在途心跳 seq（有界）：把「被业务拒绝的回执」从「迟到结果」里分辨出来。 */
  private readonly heartbeats = new Set<number>();
  /** terminal 终态收口器（不可重试终态 + 心跳被拒分类）：isFatal 即一切上发本地拒绝。 */
  private readonly terminal: BattleTerminal;

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
      onError: (err) => this.onHeartbeatError(err),
    });
    this.ending = new BattleEnding({
      drainMs: this.settings.drainMs,
      onEnded: () => this.onEnded(),
      onDrain: () => void this.release(),
    });
    this.terminal = this.buildTerminal();
    this.inbound = this.buildInbound();
    this.closeSignal = new Promise<void>((resolve) => {
      this.signalClose = resolve;
    });
  }

  /** buildTerminal 组装终态收口器的接缝（停心跳/收尾窗口/在途表/上报都挂在会话上）。 */
  private buildTerminal(): BattleTerminal {
    return new BattleTerminal({
      counters: this.counters,
      stopHeartbeat: () => this.heartbeat.stop(),
      disposeEnding: () => this.ending.dispose(),
      settleAll: (status) => this.pending.failAll({ kind: 'status', status }),
      setFailed: () => this.setState('failed'),
      report: (err) => safeCall(() => this.settings.onFailed?.(err)),
      reportHeartbeat: (err) => this.reportHeartbeatFailure(err),
      endBattle: () => this.ending.end(),
      release: () => void this.release(),
    });
  }

  /** buildInbound 组装收帧面的接缝（结算/心跳账/终态收口/推送回调都挂在会话上）。 */
  private buildInbound(): BattleInbound {
    return new BattleInbound({
      version: this.ver,
      maxBodySize: this.settings.maxBodySize,
      ops: this.settings.ops,
      settle: (seq, outcome) => this.pending.settle(seq, outcome),
      takeHeartbeat: (seq) => this.heartbeats.delete(seq),
      onHeartbeatRejected: (status) => this.terminal.onHeartbeatRejected(status),
      onTerminalReject: (status) => this.terminal.reject(status),
      absorbEnd: () => this.ending.absorb(),
      onFrame: this.settings.onFrame,
      onBattleEnd: this.settings.onBattleEnd,
      onPush: this.settings.onPush,
      frameNumberOf: this.settings.frameNumberOf,
    });
  }

  state(): BattleSessionState {
    return this.current;
  }

  ended(): boolean {
    return this.ending.isEnded();
  }

  lastSeenFrame(): number {
    return this.inbound.lastSeenFrame();
  }

  noteFrame(frameId: number): void {
    this.inbound.noteFrame(frameId);
  }

  /** stats 取本会话的只读运行统计快照（重连/握手/心跳失败；评审 P1-4）。 */
  stats(): BattleSessionStats {
    return this.counters.snapshot();
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

  async syncFrames(lastSeenFrame: number = this.lastSeenFrame(), ...opts: InvokeOption[]): Promise<unknown> {
    this.requireReady();
    return this.call(this.settings.ops.syncFrames, syncRequest(this.battleId, lastSeenFrame), opts);
  }

  /** reconnect 重新升级并恢复入局状态：已连接时幂等；并发调用共享同一轮尝试。 */
  reconnect(): Promise<void> {
    const fatal = this.terminal.error();
    if (fatal !== null) return Promise.reject(fatal); // 终态：会话无用，重连无意义
    if (this.ending.isEnded()) return Promise.reject(battleEndedError()); // 终态：不重拨（同一张票已被拒）
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

  /** close 关闭会话（幂等）：递增代次作废在途拨号，停心跳、结算在途、释放连接。 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.generation += 1; // 作废在途拨号：其结果不得再安装通道（对齐 Go 的 generation 复查）
    this.heartbeat.stop();
    this.signalClose();
    this.setState('closed');
    this.pending.failAll({ kind: 'error', error: new NetworkError('战斗直连会话已关闭') });
    await this.release();
  }

  /** onEnded 进入终态（终态不可逆）：停心跳、结算在途请求——此后一切上发都以
   *  BATTLE_ENDED 本地拒绝。连接**不立刻关**：收尾窗口内继续读完服务端在关闭前
   *  重投/补齐的结果推送（服务端会先关，那一路由 onClosed 收尾）。
   *  统计归「对局正常结束」族（有结算可展示；无结算的终态拒绝见 terminal.ts）。 */
  private onEnded(): void {
    this.counters.endedRejects += 1;
    this.heartbeat.stop();
    this.pending.failAll({ kind: 'status', status: battleEndedStatus() });
    this.setState('ended');
  }

  /** release 释放当前连接并清收尾窗口定时器（窗口到点 / close / 终态共用；幂等）。 */
  private async release(): Promise<void> {
    this.ending.dispose();
    const tr = this.transport;
    this.transport = null;
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

  /** connectLoop 建连主循环：拨号（升级带票）→ 代次复查 → 恢复入局状态。
   *  重连场景在 reconnectWindowMs 窗口内对网络类失败退避重试；首连失败与
   *  业务拒绝/协议错误立即上抛（分类见 classifyFailure）；关闭打断则静默收尾。 */
  private async connectLoop(isReconnect: boolean): Promise<void> {
    const deadline = Date.now() + this.settings.reconnectWindowMs;
    const gen = this.generation; // 本轮代次：close() 递增即整轮作废
    let attempt = 0;
    for (;;) {
      let tr: ChannelTransport | null = null;
      let phase: ConnectPhase = 'dial';
      this.inbound.reset();
      try {
        tr = await this.dial();
        phase = 'restore';
        if (!this.install(tr, gen)) return; // 拨号期间已关闭：本代作废（socket 已关、零写入）
        await this.restore(isReconnect);
        if (this.transport !== tr) throw new NetworkError('战斗直连在建立后立即断开');
        this.setState('connected');
        this.heartbeat.start(); // 保活心跳随本代连接启动（换代/关闭即停）
        if (isReconnect) {
          this.counters.reconnects += 1;
          await this.settings.onReconnected?.();
        }
        return;
      } catch (err) {
        if (tr !== null) await this.closeTransport(tr);
        if (this.closing || gen !== this.generation) return; // 关闭打断：不归类、不重试、不上报
        if (phase === 'dial') this.counters.dialFailures += 1; // 握手失败（升级未完成/被拒/超时）
        const gate = { isReconnect, closing: this.closing, ended: this.ending.isEnded(), deadline };
        // 归类只看「本轮是否已收到过回执」：判据与会话状态无关，故按值传入。
        if (!canRetry(gate, err)) throw classifyFailure(phase, err, this.inbound.receivedAny);
        attempt += 1;
        const wait = backoffDelay(this.settings.backoffBaseMs, this.settings.backoffMaxMs, attempt);
        if (!(await sleepInterruptible(wait, this.closeSignal))) return; // 关闭打断
      }
    }
  }

  /** dial 拨号接入层 WS 面：升级 URL 带票（base64url），路径取配置（默认 /）。 */
  private dial(): Promise<ChannelTransport> {
    this.counters.dialAttempts += 1;
    return dialWebSocket(
      { kind: 'ws', addr: this.address, path: this.settings.path, ticket: this.ticket },
      { wsFactory: this.settings.wsFactory, openTimeoutMs: this.settings.openTimeoutMs },
    );
  }

  /** install 接管一条新连接：代次已作废（close 已发生）即关闭并**拒装**，返回 false。
   *  拨号可能在关闭之后才返回，故代次复查必须在安装之前——不复查就会把 closed 改回
   *  connected、在关闭后继续写线，并让这条 socket 无人回收（评审 P0-7）。 */
  private install(tr: ChannelTransport, gen: number): boolean {
    if (this.closing || gen !== this.generation) {
      void tr.close().catch(() => {});
      return false;
    }
    this.transport = tr;
    void (async () => {
      let exitErr: unknown = null;
      try {
        exitErr = await this.inbound.readFrames(tr);
      } catch (err) {
        exitErr = err;
      }
      this.onClosed(tr, exitErr);
    })();
    return true;
  }

  /** restore 恢复入局状态：曾入局则重新 JoinBattle；重连额外用 SyncFrames 补帧。 */
  private async restore(isReconnect: boolean): Promise<void> {
    if (!this.joined) return;
    this.restoring = true;
    try {
      await this.call(this.settings.ops.joinBattle, { battleId: this.battleId }, []);
      if (isReconnect) await this.call(this.settings.ops.syncFrames, syncRequest(this.battleId, this.lastSeenFrame()), []);
    } finally {
      this.restoring = false;
    }
  }

  /** onClosed 连接死亡：回收 in-flight，并按错误分类决定重连或终止。 */
  private onClosed(tr: ChannelTransport, err: unknown): void {
    if (this.transport !== tr) return; // 陈旧代（本地关闭/主动弃用）：不触发重连
    this.transport = null;
    this.heartbeat.stop(); // 本代死亡即停心跳（不泄漏；重连成功后按新代再启）
    this.ending.dispose(); // 连接已死：收尾窗口无事可做（不再有待收的结果）
    const failure = classifyExit(err);
    this.pending.failAll({ kind: 'error', error: failure });
    if (this.closing || this.connecting) return; // 建连中：由 connectOnce 归类与重试
    if (this.terminal.isFatal()) return; // 会话无用终态：不重连也不报失败（已上报过）
    if (this.ending.isEnded()) return; // 终态：结算后服务端回收连接属正常，不重连也不报失败
    if (failure instanceof ProtocolError || !this.settings.autoReconnect) {
      this.fail(failure);
      return;
    }
    this.setState('reconnecting');
    void this.reconnect().catch((e: unknown) => this.fail(e));
  }

  /** fail 置失败态并通知（不重连：协议致命/自动重连关闭/重连窗口用尽）。三类情形不上报：
   *  已 close（调用方的意图，不是失败）、会话无用终态（终态收口已报过一次）、对局已结束
   *  （结束不是失败——上报 Failed 会让上层误以为要重新匹配，与 Go/C# 口径一致）。 */
  private fail(err: unknown): void {
    if (this.closing || this.terminal.isFatal() || this.ending.isEnded()) return;
    this.setState('failed');
    safeCall(() => this.settings.onFailed?.(err));
  }

  /** call 发送一次请求并等待结算（不排队：未就绪即报错，由调用方决定重发）。
   *  终态守卫在**写线之前**：终态族与「对局已结束」都不再有合法帧 op（服务端也一律拒），
   *  本地直接拒绝既不占带宽也不占待结算表。 */
  private async call(op: string, req: unknown, invokeOpts: readonly InvokeOption[]): Promise<unknown> {
    this.guardSend();
    const tr = this.transport;
    if (tr === null) throw new NetworkError('战斗直连未建立');
    const io: InvokeOptions = { failFast: true };
    for (const o of invokeOpts) o(io);
    const seq = ++this.seq;
    const payload = req === null || req === undefined ? new Uint8Array(0) : this.settings.serializer.marshal(req);
    const requestId = io.noIdempotency ? '' : (io.idempotencyKey ?? newRequestId());
    const body = buildRequestBodyFull(op, this.slot, requestId, payload);
    const outcome = this.pending.register(seq, op, io.timeoutMs ?? this.settings.invokeTimeoutMs);
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
      this.pending.settle(seq, { kind: 'error', error: classifyWriteError(err) });
    }
    return this.unwrap(await outcome);
  }

  /** sendHeartbeat 一拍保活：Tell 语义——带会话槽票、不带幂等键、**不登记 pending**
   *（回执若到由在途心跳账认领：成功丢弃、业务拒绝记账）；未就绪/恢复入局中/终态跳过本轮，
   *  避免与建连、补帧抢跑。发送失败由 BattleHeartbeat 归口到 onHeartbeatError。 */
  private async sendHeartbeat(): Promise<void> {
    const tr = this.transport;
    if (tr === null || this.closing || this.restoring || this.terminal.isFatal()) return;
    if (this.ending.isEnded() || this.current !== 'connected') return; // 终态停发（含 Ping）
    const payload = this.settings.serializer.marshal(withBattleId(this.battleId, undefined));
    const body = buildRequestBodyFull(this.settings.ops.ping, this.slot, '', payload);
    const seq = ++this.seq;
    this.trackHeartbeat(seq);
    const header: Header = {
      magic: MAGIC,
      version: this.ver,
      type: MsgType.Request,
      flags: FLAG_SESSION,
      seq,
      length: body.length,
    };
    await tr.writeFrame(header, body, this.settings.maxBodySize);
  }

  /** trackHeartbeat 登记在途心跳 seq（有界：只留最近 HEARTBEAT_TRACK 拍）。
   *  心跳没有 pending，但它的回执可能带业务拒绝——没有这份账就完全不可见（评审 R3-P1②）。 */
  private trackHeartbeat(seq: number): void {
    this.heartbeats.add(seq);
    while (this.heartbeats.size > HEARTBEAT_TRACK) {
      const oldest = this.heartbeats.values().next().value;
      if (oldest === undefined) return;
      this.heartbeats.delete(oldest);
    }
  }

  /** onHeartbeatError 心跳写线失败（本地）：计数 + 既有失败出口上报，不终止会话。 */
  private onHeartbeatError(err: unknown): void {
    this.counters.heartbeatWriteFailures += 1;
    this.reportHeartbeatFailure(err);
  }

  /** reportHeartbeatFailure 心跳失败只上报（异常隔离）：不改会话状态、不终止会话。 */
  private reportHeartbeatFailure(err: unknown): void {
    safeCall(() => this.settings.onHeartbeatFailed?.(err));
  }

  /** unwrap 归类结算结果：业务拒绝抛 BusinessError，错误原样上抛，数据交序列化器。 */
  private unwrap(outcome: PendingOutcome): unknown {
    if (outcome.kind === 'status') {
      throw businessErrorOf(outcome.status);
    }
    if (outcome.kind === 'error') throw outcome.error;
    return this.settings.serializer.unmarshal(outcome.data, null);
  }

  private async closeTransport(tr: ChannelTransport): Promise<void> {
    if (this.transport === tr) this.transport = null;
    await tr.close().catch(() => {});
  }

  /** guardSend 一切上发前的统一守卫（业务调用与内部恢复共用）：终态族 → 原样抛终态错误；
   *  对局已结束 → BATTLE_ENDED；已关闭 → NetworkError。终态优先判定，免得连接被回收后
   *  报成「未就绪」而掩盖了「这一局已经打完/这张票已经作废」。 */
  private guardSend(): void {
    const fatal = this.terminal.error();
    if (fatal !== null) throw fatal;
    if (this.ending.isEnded()) throw battleEndedError();
    if (this.closing || this.current === 'closed') throw new NetworkError('战斗直连会话已关闭');
  }

  /** requireReady 外部调用前置校验：未就绪即报错（不排队）。 */
  private requireReady(): void {
    this.guardSend();
    if (this.transport === null || this.restoring) {
      throw new NetworkError(`战斗直连未就绪（${this.current}）`);
    }
  }

  /** setState 状态迁移：关闭后不再回退成任何非关闭态（迟到拨号/迟到失败都不得把 closed
   *  改写回 connected/failed）；对局结束是终态，同样不被降级（ended 不可逆）。 */
  private setState(s: BattleSessionState): void {
    if (this.closing && s !== 'closed') return;
    if (this.ending.isEnded() && s !== 'ended' && !this.closing) return;
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
