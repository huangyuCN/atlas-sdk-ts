// Invoker 是强类型 stub 生成物（protoc-gen-atlas-client 的 TS 输出）的最小依赖：
// 会话内核 Client/ChannelView 天然满足，业务测试可注入 fake。
// 生成 stub 经 InvokeOption 透传单次请求选项，因此本接口依赖 SDK 的选项类型。
import type { InvokeOption } from './options.js';

export interface Invoker {
  invoke(op: string, req: unknown, ...opts: InvokeOption[]): Promise<unknown>;
}

// asInvoker 把内核对象（Client/ChannelView 等）适配为 Invoker（鸭子类型收窄）。
export function asInvoker(cli: { invoke(op: string, req: unknown, ...opts: InvokeOption[]): Promise<unknown> }): Invoker {
  return { invoke: (op, req, ...opts) => cli.invoke(op, req, ...opts) };
}
