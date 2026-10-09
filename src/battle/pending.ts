// 战斗直连的待结算请求表（in-flight 表）：登记 / 恰一次结算 / 批量结算。
// 拆出本模块只为让 session.ts 只留连接生命周期（单文件规模约束），语义与内核
// channel 的 in-flight 表一致：迟到结果查表丢弃、超时兜底、终态以同一结果批量了结。
import type { PendingOutcome } from '../client/channelTypes.js';
import { TimeoutError } from '../client/errors.js';

/** Pending 一条请求的等待项（超时兜底；结算恰一次）。 */
interface Pending {
  timer: ReturnType<typeof setTimeout>;
  settle: (outcome: PendingOutcome) => void;
}

export class PendingTable {
  private readonly entries = new Map<number, Pending>();

  /** register 登记一条请求（seq → 等待项）：超时以 TimeoutError 兜底结算。 */
  register(seq: number, op: string, timeoutMs: number): Promise<PendingOutcome> {
    return new Promise<PendingOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(seq, { kind: 'error', error: new TimeoutError(op, timeoutMs) });
      }, timeoutMs);
      this.entries.set(seq, { timer, settle: resolve });
    });
  }

  /** settle 结算一条请求（查表恰一次：迟到结果静默丢弃）。 */
  settle(seq: number, outcome: PendingOutcome): void {
    const entry = this.entries.get(seq);
    if (entry === undefined) return;
    this.entries.delete(seq);
    clearTimeout(entry.timer);
    entry.settle(outcome);
  }

  /** failAll 以同一结果结算全部在途请求（终态/关闭收口）。 */
  failAll(outcome: PendingOutcome): void {
    for (const [seq] of [...this.entries]) this.settle(seq, outcome);
  }
}
