// 战斗直连的收帧面（从 session.ts 拆出控制单文件规模）：读循环、响应结算、推送分发。
//
// 会话把「查表结算 / 终态收口 / 心跳记账 / 结束通知收口」以钩子注入，本模块只管帧语义：
//   - Response：版本校验 → 包络解码 →（心跳回执记账｜终态收口）→ 按 seq 结算；
//   - Notify：op 分发（帧广播推进补帧基准 + onFrame；结束通知首份为准 + onBattleEnd，
//     空载荷直接丢弃；其余 op 透传 onPush）——坏帧与回调异常都不影响读循环；
//   - 其余帧类型：协议致命（交会话终止本代连接）。
//
// 关键顺序（评审 R3-P1）：**终态判定必须在结算之前**——心跳回执没有 pending，若先走
// settle 就会被当迟到结果静默丢弃，「对局已结束/对局不存在」这类终态拒绝便永远学不到。
import type { PendingOutcome } from '../client/channelTypes.js';
import { ProtocolError } from '../client/errors.js';
import type { ChannelTransport } from '../client/transport.js';
import { MsgType, type Header } from '../frame/constants.js';
import { parseRequestBody } from '../frame/body.js';
import { decodeReply } from '../frame/reply.js';
import type { Status } from '../frame/status.js';
import { OP_BATTLE_END_NOTIFY, OP_FRAME_BROADCAST } from './opkeys.js';
import type { EndNotifyDisposition } from './ending.js';
import { isSupportedPayloadVersion } from './wire.js';

/** InboundHooks 收帧面与会话的接缝（会话注入；本模块不持有会话状态）。 */
export interface InboundHooks {
  /** 帧头载荷编码版本（本会话的载荷编码协商值）。 */
  readonly version: number;
  /** 单帧 body 上限。 */
  readonly maxBodySize: number;
  /** settle 结算一条响应（会话查 in-flight 表；恰一次）。 */
  settle(seq: number, outcome: PendingOutcome): void;
  /** takeHeartbeat 划掉一条在途心跳（命中即说明该回执属于心跳，没有 pending）。 */
  takeHeartbeat(seq: number): boolean;
  /** onHeartbeatRejected 心跳回执被业务拒绝（会话记账 + 分类处置）。 */
  onHeartbeatRejected(status: Status): void;
  /** onTerminalReject 业务拒绝的终态收口（BATTLE_ENDED 交结束收口，其余终态族置终态）。 */
  onTerminalReject(status: Status): void;
  /** absorbEnd 吸收一条结束通知（空载荷判据在 ending.ts）：'empty' 不算结束信号
   *  （调用方连统一出口都不进）、'first' 首份（会话据此回调业务一次）、'replay' 重复副本。 */
  absorbEnd(payload: Uint8Array): EndNotifyDisposition;
  /** 帧广播回调（原始载荷 + 载荷编码版本）。 */
  onFrame?: ((payload: Uint8Array, version: number) => void) | undefined;
  /** 结束通知回调（首份；原始载荷 + 版本）。 */
  onBattleEnd?: ((payload: Uint8Array, version: number) => void) | undefined;
  /** 任意战斗域推送回调（op 原样透传）。 */
  onPush?: ((op: string, payload: Uint8Array, version: number) => void) | undefined;
  /** 帧号提取钩子：**所有版本都只认本钩子**（帧广播字段属游戏协议，SDK 不持类型、
   *  不猜编码）；返回 null 表示本帧取不到帧号（不推进补帧基准、不报错——与 Go 的
   *  FrameNumberFunc 同口径）。 */
  frameNumberOf?: ((payload: Uint8Array, version: number) => number | null) | undefined;
}

export class BattleInbound {
  private lastFrame = 0;
  /** receivedAny 本轮建连是否已收到过任何回执/推送（建连失败的归类依据）。 */
  receivedAny = false;

  constructor(private readonly hooks: InboundHooks) {}

  /** lastSeenFrame 已见帧号（重连补帧的 last_seen_frame 基准）。 */
  lastSeenFrame(): number {
    return this.lastFrame;
  }

  /** noteFrame 上报已见帧号（只前进不后退）。 */
  noteFrame(frameId: number): void {
    if (Number.isInteger(frameId) && frameId > this.lastFrame) this.lastFrame = frameId;
  }

  /** reset 新一轮建连前清「本轮已收到回执」标记。 */
  reset(): void {
    this.receivedAny = false;
  }

  /** readFrames 读循环：Response 按 seq 结算、Notify 分发；其余帧类型协议致命。 */
  async readFrames(tr: ChannelTransport): Promise<unknown> {
    for (;;) {
      const f = await tr.readFrame(this.hooks.maxBodySize);
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

  /** onResponse 校验响应版本并结算 in-flight；包络非法返回协议致命错误。
   *  版本校验两道（与 Go 的 dispatchResponse 同序）：先白名单 {1,2}（未知版本 = 对端或协议
   *  缺陷，明确报错、不猜编码），再与会话载荷编码比对（白名单内的失配同样是协议级失败）。 */
  private onResponse(hdr: Header, body: Uint8Array): ProtocolError | null {
    if (!isSupportedPayloadVersion(hdr.version)) {
      return new ProtocolError(`响应帧版本 ${hdr.version} 不在载荷编码白名单 {1,2}`);
    }
    if (hdr.version !== this.hooks.version) {
      return new ProtocolError(`响应帧 version ${hdr.version} 与载荷编码 ${this.hooks.version} 不一致`);
    }
    let reply;
    try {
      reply = decodeReply(body);
    } catch (err) {
      return new ProtocolError('响应包络非法', err);
    }
    if (this.hooks.takeHeartbeat(hdr.seq)) {
      if (reply.status !== null) this.hooks.onHeartbeatRejected(reply.status);
      return null;
    }
    if (reply.status !== null) this.hooks.onTerminalReject(reply.status);
    const outcome: PendingOutcome = reply.status !== null
      ? { kind: 'status', status: reply.status }
      : { kind: 'data', data: reply.data };
    this.hooks.settle(hdr.seq, outcome);
    return null;
  }

  /** onNotify 解析推送 body 并分发；坏帧静默丢弃（推送不参与请求匹配）。 */
  private onNotify(hdr: Header, body: Uint8Array): void {
    try {
      const { operation, payload } = parseRequestBody(body);
      this.dispatch(operation, payload, hdr.version);
    } catch {
      // 静默丢弃
    }
  }

  /** dispatch 按 op 分发推送（回调异常隔离：不影响读循环）。
   *  帧号先于 onFrame 推进（回调抛异常也不丢补帧进度）；结束通知按「首份为准」收口
   *  （服务端有界重投 + 重连补投都会重复到达，业务回调必须恰一次），其中**空载荷一律丢弃**：
   *  不进终态、不回调、也不经统一出口分发（跨 SDK 统一契约——Go 的 noteEndNotify 与 C# 的
   *  NoteEndNotify 都以载荷长度为零提前返回，三语言必须同口径）。重复副本仍经 onPush 透传。 */
  private dispatch(op: string, payload: Uint8Array, version: number): void {
    try {
      if (op === OP_FRAME_BROADCAST) {
        this.noteFrame(this.extractFrameId(payload, version));
        this.hooks.onFrame?.(payload, version);
      } else if (op === OP_BATTLE_END_NOTIFY) {
        const disposition = this.hooks.absorbEnd(payload);
        if (disposition === 'empty') return; // 空载荷：连统一出口也不可见（"不分发"）
        if (disposition === 'first') this.hooks.onBattleEnd?.(payload, version);
      }
      this.hooks.onPush?.(op, payload, version);
    } catch {
      // 业务回调异常不影响读循环
    }
  }

  /** extractFrameId 提取帧广播的帧号：只认调用方注入的钩子（未注入即取不到，返回 -1 =
   *  不推进补帧基准，也不报错）。载荷编码（protojson / protobuf）与字段布局都属游戏协议，
   *  SDK 不持类型、不猜编码；与 Go 去掉内建解析后的口径一致。 */
  private extractFrameId(payload: Uint8Array, version: number): number {
    const custom = this.hooks.frameNumberOf;
    if (custom === undefined) return -1;
    return normalizeFrameNumber(custom(payload, version));
  }
}

/** normalizeFrameNumber 归一钩子返回值：只有「非负整数」才算帧号；null / undefined /
 *  负数 / 小数一律视为取不到（归 -1，由 noteFrame 的「只前进」规则自然忽略）。
 *  取不到帧号**不是错误**：二进制载荷非自描述，宁可不推进补帧基准，也不能猜编码。 */
function normalizeFrameNumber(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1;
}
