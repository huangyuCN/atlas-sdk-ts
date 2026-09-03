// 读循环与帧分发（Channel 的协作模块，模式同 reconnect/heartbeat）：
// 循环读帧 → Response 按代匹配结算 in-flight / Notify 按 operation 分发；
// 包络非法 = 协议级致命错误（终止本通道，失步连接不可再用）；
// 退出时回收本代 in-flight（断连统一失败）并触发协议错误终止判定。
import type { Channel, Generation, PendingOutcome } from './channel.js';
import type { Header } from '../frame/constants.js';
import { decodeReply } from '../frame/reply.js';
import { parseRequestBody } from '../frame/body.js';
import { NetworkError, ProtocolError } from './errors.js';
import { ProtocolError as FrameProtocolError } from '../frame/protocolError.js';

/** 通道读循环（supervisor 建代后启动；退出经 gen.done 通知）。 */
export function startReadLoop(ch: Channel, gen: Generation): void {
  void (async () => {
    let exitErr: unknown = null;
    try {
      for (;;) {
        const f = await gen.transport.readFrame(ch.settings.maxBodySize);
        if (f.header.type === 2) {
          const fatal = dispatchResponse(ch, gen, f.header, f.body);
          if (fatal) {
            exitErr = fatal;
            break;
          }
        } else if (f.header.type === 3) {
          dispatchNotify(ch, f.body);
        } else {
          exitErr = new ProtocolError(`收到非法帧类型 ${f.header.type}`);
          break;
        }
      }
    } catch (err) {
      exitErr = err;
    }
    onGenerationDead(ch, gen, exitErr);
  })();
}

/** Response 帧：按 (epoch, seq) 匹配 in-flight 结算；包络非法返回致命错误。 */
function dispatchResponse(ch: Channel, gen: Generation, hdr: Header, body: Uint8Array): ProtocolError | null {
  let reply;
  try {
    reply = decodeReply(body);
  } catch (err) {
    return new ProtocolError('响应包络非法', err);
  }
  const key = `${gen.epoch}:${hdr.seq}`;
  ch.settleInflight(
    key,
    reply.status ? { kind: 'status', status: reply.status } : { kind: 'data', data: reply.data },
  );
  return null;
}

/** Notify 帧：解析 body 的 (operation, payload) 分发到订阅者；坏帧静默丢弃
 * （推送不参与请求匹配，丢失不影响一致性）。 */
function dispatchNotify(ch: Channel, body: Uint8Array): void {
  try {
    const { operation, payload } = parseRequestBody(body);
    ch.notifier.dispatch(operation, payload);
  } catch {
    // 静默丢弃
  }
}

function onGenerationDead(ch: Channel, gen: Generation, exitErr: unknown): void {
  gen.finish();
  // 回收本代 in-flight（幂等；close 路径亦调用）：断连统一失败。
  for (const [key, entry] of [...ch.inflightSnapshot()]) {
    if (key.startsWith(`${gen.epoch}:`)) {
      ch.settleInflight(key, { kind: 'error', error: classifyExit(exitErr) });
    }
  }
  if (exitErr instanceof ProtocolError || exitErr instanceof FrameProtocolError) {
    ch.terminate();
    return;
  }
  // 网络断连：连接已死即置 Reconnecting（supervisor 随后退避重拨）——
  // 不留「连接已死但状态仍 Connected」的窗口。
  ch.markReconnecting();
}

/** 读循环退出错误归类：协议非法 → ProtocolError（终止不重连）；其余 → NetworkError。 */
function classifyExit(err: unknown): NetworkError | ProtocolError {
  if (err instanceof ProtocolError) return err;
  if (err instanceof FrameProtocolError) return new ProtocolError('帧协议非法', err);
  if (err instanceof NetworkError) return err;
  return new NetworkError(err instanceof Error ? err.message : String(err));
}
