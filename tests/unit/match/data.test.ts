import { describe, expect, it } from "vitest";

import { routeRelayedData, type MatchDataFilter } from "../../../src/domain/match/data";
import type { MatchPresence } from "../../../src/domain/match/presence";

/**
 * M7 契约：中继对局的收件人路由。
 *
 * 上游 `pipeline_match.go::matchDataSend` 的中继那一支有四条规则，每条都很容易写反：
 *   1. 发送者必须是成员，否则**静默关连接**；
 *   2. 没有过滤器时**不回显**给发送者；
 *   3. 有过滤器时按过滤器说话，**包括发送者自己**（想收自己的回显就得把自己写进过滤器）；
 *   4. 过滤器是**一次性**的，而且"给过过滤器"这件事本身是永久的——用完之后剩下的成员
 *      会被丢掉，不是"过滤器用完就全发"。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 *
 * REQ-0001-018
 */

const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";
const THREE = "33333333-3333-4333-8333-333333333333";

function presence(sessionId: string): MatchPresence {
  return { node: "", userId: `u-${sessionId}`, sessionId, username: sessionId };
}

function filter(sessionId: string): MatchDataFilter {
  return { userId: `u-${sessionId}`, sessionId };
}

function ids(presences: readonly MatchPresence[]): string[] {
  return presences.map((item) => item.sessionId);
}

describe("M7 中继对局: 数据路由", () => {
  it("test_the_sender_is_not_echoed_when_there_is_no_filter", () => {
    const route = routeRelayedData(ONE, [presence(ONE), presence(TWO), presence(THREE)], []);
    expect(route.senderFound).toBe(true);
    expect(ids(route.recipients)).toEqual([TWO, THREE]);
  });

  it("test_a_sender_that_is_not_a_member_is_not_found", () => {
    const route = routeRelayedData(ONE, [presence(TWO), presence(THREE)], []);
    expect(route.senderFound).toBe(false);
    // 上游在这一支 `return false, nil`：调用方知道"别发帧、关连接"，
    // 而"发给谁"这件事已经没有意义了——这里仍然给出一份可用结果。
    expect(ids(route.recipients)).toEqual([TWO, THREE]);
  });

  it("test_a_filter_list_is_one_shot_and_can_include_the_sender", () => {
    const route = routeRelayedData(ONE, [presence(ONE), presence(TWO), presence(THREE)], [
      filter(ONE),
      filter(THREE),
    ]);
    expect(route.senderFound).toBe(true);
    // 发送者把自己写进过滤器 → 收到自己的回显；THREE 也收。
    expect(ids(route.recipients)).toEqual([ONE, THREE]);
  });

  it("test_a_filter_matches_at_most_once", () => {
    // 同一个会话被写两次：只匹配一次（上游那条 `filters[j] = filters[len-1]; filters = filters[:len-1]`）。
    const route = routeRelayedData(ONE, [presence(ONE)], [filter(ONE), filter(ONE)]);
    expect(ids(route.recipients)).toEqual([ONE]);
  });

  it("test_leftover_members_are_dropped_once_a_filter_list_was_given", () => {
    // 三个成员、只给了两个过滤器：第三个既不在过滤器里、也不是"没给过滤器"，
    // 所以被丢掉（上游判的是 `filters != nil` 而不是 `len(filters) > 0`）。
    const route = routeRelayedData(TWO, [presence(ONE), presence(TWO), presence(THREE)], [
      filter(ONE),
    ]);
    expect(route.senderFound).toBe(true);
    expect(ids(route.recipients)).toEqual([ONE]);
  });

  it("test_filters_are_matched_case_insensitively", () => {
    // 上游两边都是 16 字节的 uuid，比较天然不区分大小写；客户端传什么都该命中。
    const route = routeRelayedData(ONE, [presence(TWO)], [filter(TWO.toUpperCase())]);
    expect(ids(route.recipients)).toEqual([TWO]);
  });
});
