// Channel：连接本体（对齐 Go 侧 channel 结构）。一个 Channel 管理一条逻辑通道的
// 全部生命周期：代（generation）隔离的连接、读循环与帧分发、(epoch, seq) 请求匹配、
// Notify 订阅分发、重连排队、会话钩子与 hookBypass 直通窗口。
//
// 状态机：disconnected → connecting → connected ⇄ reconnecting（协议错误终止回
// disconnected 且不重连）。重连编排（supervisor）与心跳循环在 reconnect.ts /
// heartbeat.ts 中作为协作模块实现，通过本类暴露的内部协作方法交互。
import { buildRequestBody } from '../frame/body.js';
import type { Status } from '../frame/status.js';
import { BusinessError, NetworkError, ProtocolError, TimeoutError } from './errors.js';
import { NotifyRegistry, type NotifyHandler } from './notify.js';
import {
  applyOptions,
  type InvokeOption,
  type InvokeOptions,
  type Option,
} from './options.js';
import type { ChannelTransport, DialConfig, TransportDialer } from './transport.js';

/** 通道角色：业务 / 战斗（dual 形态）。 */
export const Kind = {
  Business: 'business',
  Battle: 'battle',
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** 通道连接状态。 */
export type ChannelState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** 传输心跳死链判定阈值：连续失败次数（网络类失败才计数，业务拒绝不计）。 */
export const HEARTBEAT_FAILURES = 3;

/** 传输保活心跳 operation（服务端引擎内置空响应 handler）。 */
export const HeartbeatOperation = '/atlas.internal.Heartbeat/Ping';

/** 一代连接：每次拨号成功分配一个 Generation；epoch 单调递增隔离新旧代。 */
export interface Generation {
  readonly epoch: number;
  readonly transport: ChannelTransport;
  /** 读循环退出（连接死亡）时 settle。 */
  readonly done: Promise<void>;
  /** 内部：resolve done（onGenerationDead 调用）。 */
  readonly finish: () => void;
}

interface PendingEntry {
  settle: (outcome: PendingOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** @internal 同目录协作模块（readloop）使用；不进公共导出面。 */
export type PendingOutcome =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'status'; status: Status }
  | { kind: 'error'; error: AtlasErrorKind };

interface QueuedRequest {
  op: string;
  req: unknown;
  io: InvokeOptions;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

type AtlasErrorKind = NetworkError | TimeoutError | ProtocolError;

const MAGIC_DEFAULT = 0x41544c53;
const VERSION_DEFAULT = 1;

/** 创建一个 Channel（连接本体；start 由 Client 编排器驱动）。 */
export function newChannel(args: {
  dialer: TransportDialer;
  dialConfig: DialConfig;
  kind: Kind;
  opts: readonly Option[];
}): Channel {
  return new Channel(args);
}

export class Channel {
  readonly kind: Kind;
  readonly dialConfig: DialConfig;
  readonly settings: ReturnType<typeof applyOptions>;
  readonly dialer: TransportDialer;

  private _state: ChannelState = 'disconnected';
  private _closed = false;
  /** 协议级致命错误标志：置位后 supervisor 不再重连。 */
  protocolFatal = false;
  /** 会话钩子同步执行中（hookBypass 直通窗口）：Invoke 直通当前代连接。 */
  hookBypass = false;
  /** 会话心跳循环已启动（仅一次；评审缺陷：每代启动会泄漏并发循环）。 */
  sessionLoopStarted = false;
  /** 会话心跳路径的重登钩子单飞标记（避免并发重登）。 */
  sessionHookBusy = false;
  /** drain 进行中：新请求继续入队保持 FIFO（排队严格先于新请求）。 */
  private draining = false;

  private gen: Generation | null = null;
  private seqCounter = 0;
  private readonly inflight = new Map<string, PendingEntry>();
  private readonly queue: QueuedRequest[] = [];
  /** @internal 同目录协作模块（readloop）使用；不进公共导出面。 */
  readonly notifier = new NotifyRegistry();
  /** 写串行链：帧级原子（并发写不交错）。 */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** supervisor 完成信号（Close 等待内部循环退出）。 */
  internalDone: Promise<void> = Promise.resolve();
  /** close 信号（打断退避睡眠等）。 */
  private readonly closeSignal = new Promise<void>((r) => {
    this.signalClose = r;
  });
  private signalClose!: () => void;
  /** 首连等待者（newClient await 首次连接结果；重连不走此路径）。 */
  private connectWaiter: { resolve: () => void; reject: (e: unknown) => void } | null = null;

  constructor(args: {
    dialer: TransportDialer;
    dialConfig: DialConfig;
    kind: Kind;
    opts: readonly Option[];
  }) {
    this.kind = args.kind;
    this.dialConfig = args.dialConfig;
    this.dialer = args.dialer;
    this.settings = applyOptions(args.opts);
  }

  get state(): ChannelState {
    return this._state;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** close 信号（协作模块监听以打断等待）。 */
  get onClosed(): Promise<void> {
    return this.closeSignal;
  }

  /** 订阅推送（订阅生命周期归通道：重连后自动生效，无需显式重放）。 */
  on(op: string, handler: NotifyHandler): () => void {
    return this.notifier.on(op, handler);
  }

  /** 当前代（无连接为 null）。 */
  currentGeneration(): Generation | null {
    return this.gen;
  }

  setState(s: ChannelState): void {
    if (!this._closed) this._state = s;
  }

  // ---- Invoke ----

  /** 请求-响应（默认业务语义由 Client 编排层提供；本层即本通道）。
   * 重连期间默认排队（上限 WithReconnectQueueSize），WithFailFast 立即失败。 */
  async invoke(op: string, req: unknown, ...invokeOpts: InvokeOption[]): Promise<unknown> {
    if (this._closed) throw new NetworkError('客户端已关闭');
    const io: InvokeOptions = { failFast: false };
    for (const o of invokeOpts) o(io);
    // hookBypass 直通窗口（钩子同步执行期间）：钩子的重登/重绑请求与传输心跳
    // 不排队（队列要等钩子成功后才 drain）；已文档化的取舍：窗口内外部并发调用
    // 同样直通当前代连接（无法按调用方区分），窗口上限 = hookTimeout。
    if (this.hookBypass) return this.invokeOnce(op, req, io);
    if (io.failFast) {
      if (this._state !== 'connected') {
        throw new NetworkError(`未连接（${this._state}），failFast 拒绝`);
      }
      return this.invokeOnce(op, req, io);
    }
    // 排队判定与入队在同一同步块（单线程原子，与 drain 互斥）；drain 进行中
    // 的新请求同样入队，保持「排队请求严格先于新请求」的 FIFO。
    if (this.draining || this._state !== 'connected') {
      return this.enqueue(op, req, io);
    }
    return this.invokeOnce(op, req, io);
  }

  private async invokeOnce(op: string, req: unknown, io: InvokeOptions): Promise<unknown> {
    if (this._closed) throw new NetworkError('客户端已关闭');
    // Reconnecting 期间不写帧：死连接的写可能进内核缓冲后无响应、等待完整超时。
    // 例外：hookBypass（钩子的重登请求正是为建立会话，必须直通当前代连接）。
    if (this._state === 'reconnecting' && !this.hookBypass) {
      throw new NetworkError(`正在重连（${this._state}）`);
    }
    const gen = this.gen;
    if (!gen) throw new NetworkError('连接未建立');
    const seq = ++this.seqCounter;
    const body = buildRequestBody(op, this.settings.serializer.marshal(req));
    const timeoutMs = io.timeoutMs ?? this.settings.invokeTimeoutMs;
    const key = `${gen.epoch}:${seq}`;
    const outcome = await new Promise<PendingOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleInflight(key, { kind: 'error', error: new TimeoutError(op, timeoutMs) });
      }, timeoutMs);
      const entry: PendingEntry = {
        timer,
        // 结算入口统一走 settleInflight（查表判重保证恰一次：迟到响应静默丢弃）。
        settle: (o) => resolve(o),
      };
      this.inflight.set(key, entry);
      void this.writeExclusive(() =>
        gen.transport.writeFrame(
          { magic: MAGIC_DEFAULT, version: VERSION_DEFAULT, type: 1, seq, length: body.length },
          body,
          this.settings.maxBodySize,
        ),
      ).catch((err) => {
        // 评审缺陷修复：encodeFrame 抛的本地协议错误（如 body 超限——配置问题）
        // 不得误分类为 NetworkError（否则触发无意义重连）；保留其 ProtocolError
        // 身份，其余错误包 NetworkError。
        const e = err instanceof ProtocolError ? err : new NetworkError('发送失败', err);
        this.settleInflight(key, { kind: 'error', error: e });
      });
    });
    if (outcome.kind === 'status') {
      throw new BusinessError(
        outcome.status.code,
        outcome.status.reason,
        outcome.status.message,
        outcome.status.metadata,
      );
    }
    if (outcome.kind === 'error') throw outcome.error;
    return this.settings.serializer.unmarshal(outcome.data, null);
  }

  private enqueue(op: string, req: unknown, io: InvokeOptions): Promise<unknown> {
    if (this.queue.length >= this.settings.reconnectQueueSize) {
      return Promise.reject(new NetworkError('重连排队已满'));
    }
    const timeoutMs = io.timeoutMs ?? this.settings.invokeTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const item: QueuedRequest = { op, req, io, resolve, reject, timer: null as never };
      item.timer = setTimeout(() => {
        const idx = this.queue.indexOf(item);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new TimeoutError(op, timeoutMs));
      }, timeoutMs);
      this.queue.push(item);
    });
  }

  /** 钩子成功置 Connected 后按序重发排队请求（与置位同节奏启动，保持 FIFO）。 */
  drainQueue(): void {
    if (this.draining) return;
    this.draining = true;
    void (async () => {
      while (this._state === 'connected' && !this._closed) {
        const item = this.queue.shift();
        if (!item) break;
        clearTimeout(item.timer);
        try {
          item.resolve(await this.invokeOnce(item.op, item.req, item.io));
        } catch (err) {
          item.reject(err);
        }
      }
      this.draining = false;
      if (this._closed) this.failQueued();
    })();
  }

  private failQueued(): void {
    for (const item of this.queue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new NetworkError('客户端已关闭'));
    }
  }


  // ---- 代管理与生命周期 ----

  makeGeneration(transport: ChannelTransport): Generation {
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    this.gen = { epoch: (this.gen?.epoch ?? 0) + 1, transport, done, finish };
    return this.gen;
  }

  currentTransport(): ChannelTransport | null {
    return this.gen?.transport ?? null;
  }

  closeTransport(): void {
    void this.gen?.transport.close().catch(() => {});
  }

  /** 会话钩子同步执行：带超时 + panic 保护（async 链吞异常等价）；执行期间
   * hookBypass 置位（Invoke 直通当前代连接）；返回错误视为本次重连未完成。 */
  async runHook(gen: Generation): Promise<Error | null> {
    const fn = this.settings.onReconnected;
    if (!fn) return null;
    this.hookBypass = true;
    try {
      return await new Promise<Error | null>((resolve) => {
        const timer = setTimeout(
          () => resolve(new Error(`重连钩子超时（${this.settings.hookTimeoutMs}ms）`)),
          this.settings.hookTimeoutMs,
        );
        void Promise.resolve()
          .then(fn)
          .then(
            () => {
              clearTimeout(timer);
              resolve(null);
            },
            (err: unknown) => {
              clearTimeout(timer);
              resolve(err instanceof Error ? err : new Error(String(err)));
            },
          );
        void gen.done.then(() => {
          clearTimeout(timer);
          resolve(new Error('连接已关闭'));
        });
      });
    } finally {
      this.hookBypass = false;
    }
  }

  /** 钩子成功收尾：置 Connected 并启动排队 drain（FIFO：先入队者先重发）。 */
  settleGeneration(): void {
    this._state = 'connected';
    const w = this.connectWaiter;
    this.connectWaiter = null;
    w?.resolve();
    this.drainQueue();
  }

  /** 等待首次连接成功（newClient 构造入口；失败 reject 且 supervisor 停止）。 */
  waitFirstConnect(): Promise<void> {
    if (this._state === 'connected') return Promise.resolve();
    if (this._closed || this.protocolFatal) {
      return Promise.reject(new NetworkError('通道已终止'));
    }
    return new Promise<void>((resolve, reject) => {
      this.connectWaiter = { resolve, reject };
    });
  }

  /** 首连失败：拒绝等待者并停止 supervisor（对齐 Go Dial 失败返回错误）。 */
  failFirstConnect(err: unknown): void {
    const w = this.connectWaiter;
    this.connectWaiter = null;
    this._state = 'disconnected';
    w?.reject(new NetworkError('首次连接失败', err));
  }

  /** 会话心跳业务错误 → 单飞触发重登钩子：重连钩子执行中（hookBypass）或上一轮
   * 触发未完成时跳过，避免并发重登竞态；失败静默，下一轮会话心跳再触发。 */
  triggerReloginHook(): void {
    if (this.hookBypass || this.sessionHookBusy || this._closed) return;
    const fn = this.settings.onReconnected;
    if (!fn) return;
    this.sessionHookBusy = true;
    void (async () => {
      try {
        await fn();
      } catch {
        // 失败静默（下一轮会话心跳再触发）
      } finally {
        this.sessionHookBusy = false;
      }
    })();
  }

  /** 协议级致命：终止本通道（不重连）。幂等。 */
  terminate(): void {
    this.protocolFatal = true;
    if (!this._closed) this._state = 'disconnected';
    this.closeTransport();
  }

  /** 优雅关闭：幂等；停心跳/读循环、取消全部 in-flight 与排队（NetworkError）。 */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.signalClose();
    this.notifier.clear();
    this.failAllInflight();
    this.failQueued();
    this.closeTransport();
    this._state = 'disconnected';
    await this.internalDone.catch(() => {});
  }

  /** @internal 本代 in-flight 快照（readloop 回收用）。 */
  inflightSnapshot(): Array<[string, PendingEntry]> {
    return [...this.inflight];
  }

  /** @internal 网络断连后的状态置位（连接已死即 Reconnecting，无窗口期）。 */
  markReconnecting(): void {
    if (!this._closed && !this.protocolFatal) this._state = 'reconnecting';
  }

  queueLength(): number {
    return this.queue.length;
  }

  inFlightCount(epoch?: number): number {
    if (epoch === undefined) return this.inflight.size;
    let n = 0;
    for (const key of this.inflight.keys()) if (key.startsWith(`${epoch}:`)) n++;
    return n;
  }

  /** @internal 同目录协作模块（readloop）使用；不进公共导出面。 */
  failAllInflight(): void {
    for (const [key, entry] of [...this.inflight]) {
      this.inflight.delete(key);
      clearTimeout(entry.timer);
      entry.settle({ kind: 'error', error: new NetworkError('客户端已关闭') });
    }
  }

  /** @internal 同目录协作模块（readloop）使用；不进公共导出面。 */
  settleInflight(key: string, outcome: PendingOutcome | { kind: 'timeout'; error: TimeoutError }): void {
    const entry = this.inflight.get(key);
    if (!entry) return; // 已结算：迟到结果静默丢弃
    this.inflight.delete(key);
    clearTimeout(entry.timer);
    entry.settle(outcome as PendingOutcome);
  }

  private writeExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

