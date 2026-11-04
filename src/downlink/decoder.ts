// ver=3 下行解码状态机（每战斗会话一份），与 atlas-game-layout/lib/downlink/session.go 同构：
//
//	收到 ver=1/2 全量: 基线重置到该帧，交付上层，清 pending
//	收到 ver=3 增量:   序号不连续或 base_seq 与自己不符 ⇒ 丢弃 + 请求关键帧（去重）
//	                   序号 <= 基线                   ⇒ 迟到/重复，静默丢弃
//	                   其余                           ⇒ 合并后按 ver=2 全量交付
//
// **不缓冲后续增量等关键帧**：那会把「一个可恢复的失步」变成「一段静默花屏」。
import { VERSION_2, VERSION_3 } from '../frame/index.js';
import { mergeDelta, parseDelta, readFrameId } from './merge.js';

/** DecodedFrame 是一次交付：payload 恒为**全量** FrameBroadcast 字节，version 恒为 2。 */
export interface DecodedFrame {
  payload: Uint8Array;
  version: number;
}

/** Requester 发送关键帧请求的端口（由会话层注入：发 RequestFrameKeyframe(lastSeq)）。 */
export type Requester = (lastSeq: number) => void;

/** DownlinkDecoder 是每战斗会话一份的解码状态机（设计 §4.3）。 */
export class DownlinkDecoder {
  private base: Uint8Array | null = null;
  private last = 0;
  private waiting = false;
  private requestCount = 0;
  private dropCount = 0;

  /** request 缺失时只丢弃失步帧（纯解码形态，与 Go 的 nil Requester 同口径）。 */
  constructor(private readonly request?: Requester) {}

  /** lastSeq 当前基线帧号（= 已交付的最后一帧）。 */
  lastSeq(): number {
    return this.last;
  }

  /** pending 是否已请求关键帧但还没拿到。 */
  pending(): boolean {
    return this.waiting;
  }

  /** requests 累计发出的关键帧请求次数（去重后）。 */
  requests(): number {
    return this.requestCount;
  }

  /** drops 累计丢弃的增量条数。 */
  drops(): number {
    return this.dropCount;
  }

  /** apply 处理一帧载荷：ver=1/2 全量、ver=3 增量。
   *  返回 null = 本帧不交付（失步/迟到/无基线）；载荷本身解不开抛 DownlinkError。 */
  apply(payload: Uint8Array, version: number): DecodedFrame | null {
    if (version === VERSION_3) return this.applyDelta(payload);
    if (version !== 1 && version !== VERSION_2) {
      throw new Error(`downlink: 未知的载荷版本 ${version}`);
    }
    if (version === 1) {
      // ver=1 是 protojson，SDK 不解析游戏域 JSON：不能建立二进制基线，宁可请求关键帧，
      // 也不猜「基线帧号」。（协商到 ver=1 时服务端本就永不下发 ver=3。）
      this.base = null;
      this.last = 0;
      this.waiting = false;
      return { payload, version };
    }
    this.base = payload;
    this.last = readFrameId(payload) ?? this.last;
    this.waiting = false;
    return { payload, version };
  }

  /** applyDelta 严格校验基线，不符即丢弃并请求关键帧（不猜、不缓冲）。 */
  private applyDelta(payload: Uint8Array): DecodedFrame | null {
    const delta = parseDelta(payload);
    if (this.base === null) {
      this.requestKeyframe();
      return null; // 没有基线：无从合并，请求关键帧
    }
    if (delta.seq <= this.last) return null; // 迟到/重复：静默丢弃（不发请求）
    if (delta.seq !== this.last + 1 || delta.baseSeq !== this.last) {
      this.dropCount += 1;
      this.requestKeyframe();
      return null;
    }
    const merged = mergeDelta(this.base, delta);
    this.base = merged;
    this.last = delta.seq;
    this.waiting = false;
    return { payload: merged, version: VERSION_2 };
  }

  /** requestKeyframe 发一次关键帧请求（同一 pending 窗口内只发一次）。 */
  private requestKeyframe(): void {
    if (this.waiting) return;
    this.waiting = true;
    this.requestCount += 1;
    this.request?.(this.last);
  }
}
