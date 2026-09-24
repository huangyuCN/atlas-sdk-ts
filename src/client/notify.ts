// Notify 订阅表：按 operation 的多路订阅分发（SDK 相对服务端客户端引擎单 handler
// 替换式 API 的增量价值所在）。
//   - 同一 (op, handler) 幂等去重（重复 On 不产生重复分发）；
//   - 任意 op 订阅（onAny）：不预设 op 的观察者，会话协议接缝据此判定推送用途
//     （如「被挤下线」推送的 op 由接缝自报，SDK 内核不写会话消息类型字面量）；
//   - 返回退订句柄（off 函数）；
//   - handler 异常（同步抛出 / 异步 reject）隔离：不影响其他订阅者与读循环；
//   - 重连后订阅重放由 Channel 直接复用本表（订阅生命周期归通道，不随连接代次失效）。

export type NotifyHandler = (
  operation: string,
  payload: Uint8Array,
  /** 帧头载荷编码版本（1 = JSON/protojson、2 = protobuf wire）：推送载荷非自描述，
   * 消费者按它选择解码器（会话接缝的 PushEnvelope.version 即此值）。 */
  version: number,
) => void | Promise<void>;

/** 订阅表。 */
export class NotifyRegistry {
  /** op → handler 集合（Set 天然幂等去重：同 handler 重复注册只占一席）。 */
  private readonly subs = new Map<string, Set<NotifyHandler>>();

  /** 任意 op 订阅集合（每条 Notify 都会分发，与 op 订阅并存、各自独立去重）。 */
  private readonly anySubs = new Set<NotifyHandler>();

  /** 订阅；返回退订函数。同 (op, handler) 重复订阅幂等，off 一次即全部解除。 */
  on(op: string, handler: NotifyHandler): () => void {
    let set = this.subs.get(op);
    if (!set) {
      set = new Set();
      this.subs.set(op, set);
    }
    set.add(handler);
    let done = false;
    return () => {
      if (done) return; // 退订句柄幂等（重复调用无副作用）
      done = true;
      const cur = this.subs.get(op);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) this.subs.delete(op);
    };
  }

  /** OnAny 订阅全部推送 op（不预设 op 的观察者；同 handler 重复订阅幂等）。 */
  onAny(handler: NotifyHandler): () => void {
    this.anySubs.add(handler);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.anySubs.delete(handler);
    };
  }

  /** 分发一帧到该 op 的订阅者与全部 onAny 订阅者（快照后逐个调用，异常隔离）；
   * version 为帧头载荷编码版本，原样透传给订阅者（推送载荷非自描述）。 */
  dispatch(op: string, payload: Uint8Array, version: number): void {
    const set = this.subs.get(op);
    if (set && set.size > 0) {
      for (const handler of [...set]) {
        invokeSafe(handler, op, payload, version);
      }
    }
    for (const handler of [...this.anySubs]) {
      invokeSafe(handler, op, payload, version);
    }
  }

  /** 是否有该 op 的订阅者（测试与观测用；onAny 订阅者不计入）。 */
  hasSubscribers(op: string): boolean {
    return (this.subs.get(op)?.size ?? 0) > 0;
  }

  /** 清空全部订阅（Close 收尾）。 */
  clear(): void {
    this.subs.clear();
    this.anySubs.clear();
  }
}

/** handler 异常隔离：同步异常吞掉（单订阅者异常不影响其他分发）；
 * 异步返回值（Promise）的 rejection 同样吞掉（handler 自担错误处理责任）。 */
function invokeSafe(
  handler: NotifyHandler,
  op: string,
  payload: Uint8Array,
  version: number,
): void {
  try {
    const r = handler(op, payload, version);
    if (r instanceof Promise) r.catch(() => {});
  } catch {
    // 单 handler 异常不影响其他分发（对齐 Go panic recovery 语义）
  }
}
