/**
 * 一行成员记录 → 线上形状的 presence。**唯一一处翻译。**
 *
 * 分出来是因为"成员表怎么存"（`channel-members.ts`）与"presence 长什么样"
 * （`realtime/channel.ts`）之间只有这一条缝，而这条缝被频道语义和群事件两边都要用。
 * 两处各写一份翻译，迟早会在某一边忘记跟改（比如忘了 `persistence` 的
 * `0/1 → false/true`），而那种偏差在测试里表现为"某个字段莫名是 0"。
 */

import type { ChannelPresence } from "../realtime/channel";
import type { MemberRow } from "./channel-members";

export function presenceOfRow(row: MemberRow): ChannelPresence {
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    username: row.username,
    persistence: row.persistence === 1,
  };
}
