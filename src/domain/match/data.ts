/**
 * 中继对局的 `match_data_send` 路由。
 *
 * 上游 `pipeline_match.go::matchDataSend` 在"中继对局"这一支上有两段容易抄错的逻辑，
 * 这里把它们从"发帧"里剥出来做成纯函数，好被逐条断言：
 *
 * 1. **不回显发送者**：不带 `presences` 过滤时，发送者自己会被从收件人里摘掉
 *    （上游那句 `presenceIDs[i] = presenceIDs[len-1]` 的删除就是把发送者踢出去）。
 *    但它**仍然是成员**——摘不到"发送者不在场"就不能发。
 * 2. **带 `presences` 时完全按过滤器说话**：只有出现在过滤列表里的会话才收得到，
 *    包括发送者自己（想收自己的回显就得把自己写进过滤器）。过滤器是**一次性**的：
 *    一个过滤器匹配过一次就被消耗掉，所以同一个会话被写两次只匹配一次。
 *
 * 还有一个反直觉的细节：过滤列表**一旦给了就一直是"有过滤"状态**——上游用的是
 * `filters != nil` 而不是 `len(filters) > 0`，所以把 3 个过滤器用完之后，剩下的成员
 * 会被**全部丢掉**（不是"过滤器用完了就都发"）。这里用 `hasFilters` 明确表达这件事。
 *
 * 比较用的是**规范化后的小写标准形**：上游两边都是 `uuid.UUID`，比较的是 16 字节，
 * 天然不区分大小写与连字符写法；我们这边线上传下来的可能是任意写法，所以在这一层
 * 统一小写（调用方已经把它们规范成带连字符的标准形）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 *
 * REQ-0001-018
 */

import type { MatchPresence } from "./presence";

/** 上游 `matchDataFilter`：一条过滤项就是一个 (userId, sessionId) 对。 */
export interface MatchDataFilter {
  readonly userId: string;
  readonly sessionId: string;
}

export interface MatchDataRoute {
  /** 发送者是不是这个对局的成员。false 时调用方**不发任何帧**并关连接。 */
  readonly senderFound: boolean;
  /** 这一帧该发给谁（已按上游规则摘掉发送者/过滤器外的成员）。 */
  readonly recipients: readonly MatchPresence[];
}

export function routeRelayedData(
  senderSessionId: string,
  members: readonly MatchPresence[],
  filters: readonly MatchDataFilter[],
): MatchDataRoute {
  const sender = senderSessionId.toLowerCase();
  const hasFilters = filters.length > 0;
  const pending = filters.map((filter) => filter.sessionId.toLowerCase());
  const recipients: MatchPresence[] = [];
  let senderFound = false;

  for (const member of members) {
    const sessionId = member.sessionId.toLowerCase();
    if (sessionId === sender) {
      senderFound = true;
      // 不带过滤：别把发送者自己的消息回给他（上游的 break 那一支）。
      if (!hasFilters) continue;
    }
    if (hasFilters) {
      const at = pending.indexOf(sessionId);
      if (at < 0) continue;
      pending.splice(at, 1);
    }
    recipients.push(member);
  }

  return { senderFound, recipients };
}
