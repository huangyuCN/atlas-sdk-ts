// Notify 订阅表：按 operation 的多路订阅分发（SDK 相对服务端客户端引擎单 handler
// 替换式 API 的增量价值所在）。
//   - 同一 (op, handler) 幂等去重（重复 On 不产生重复分发）；
//   - 返回退订句柄（off 函数）；
//   - handler 异常（同步抛出 / 异步 reject）隔离：不影响其他订阅者与读循环；
//   - 重连后订阅重放由 Channel 直接复用本表（订阅生命周期归通道，不随连接代次失效）。

export type NotifyHandler = (operation: string, payload: Uint8Array) => void | Promise<void>;

/** 订阅表。 */
export class NotifyRegistry {
  /** op → handler 集合（Set 天然幂等去重：同 handler 重复注册只占一席）。 */
  private readonly subs = new Map<string, Set<NotifyHandler>>();

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

  /** 分发一帧到该 op 的全部订阅者（快照后逐个调用，异常隔离）。 */
  dispatch(op: string, payload: Uint8Array): void {
    const set = this.subs.get(op);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      invokeSafe(handler, op, payload);
    }
  }

  /** 是否有该 op 的订阅者（测试与观测用）。 */
  hasSubscribers(op: string): boolean {
    return (this.subs.get(op)?.size ?? 0) > 0;
  }

  /** 清空全部订阅（Close 收尾）。 */
  clear(): void {
    this.subs.clear();
  }
}

/** handler 异常隔离：同步异常吞掉（单订阅者异常不影响其他分发）；
 * 异步返回值（Promise）的 rejection 同样吞掉（handler 自担错误处理责任）。 */
function invokeSafe(handler: NotifyHandler, op: string, payload: Uint8Array): void {
  try {
    const r = handler(op, payload);
    if (r instanceof Promise) r.catch(() => {});
  } catch {
    // 单 handler 异常不影响其他分发（对齐 Go panic recovery 语义）
  }
}
