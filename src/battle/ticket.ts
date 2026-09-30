// 战斗票据的线上取值约定（规格 §3.2/§3.3：同一张票两处用）。
// 票密文只以 **base64url（RawURLEncoding，无填充）** 形态出现在线上：
//   - 接入层握手：WS 升级 query `?ticket=<取值>`（或头 X-Atlas-Ticket，本 SDK 用 query）；
//   - battle 帧会话槽：frame.FLAG_SESSION 段的字节 = 同一取值的 ASCII（帧协议零改动）。
import { encodeBase64UrlRaw } from '../frame/base64.js';
import { ProtocolError } from '../client/errors.js';

/** ticketSlotValue 计算票据的线上取值（升级 query 与帧会话槽共用）。
 * 空票显式报错：无票帧会被 battle 判 BATTLE_TICKET_INVALID，不如在发送前拦下。 */
export function ticketSlotValue(ticket: Uint8Array): string {
  if (ticket.length === 0) {
    throw new ProtocolError('battle: 票据为空，无法生成帧会话槽/升级 query');
  }
  return encodeBase64UrlRaw(ticket);
}
