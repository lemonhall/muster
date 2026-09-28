import { describe, expect, it } from "vitest";

import {
  LOCAL_NODE,
  formatMatchId,
  isAuthoritativeMatch,
  matchKeyOf,
  parseMatchId,
} from "../../../src/domain/match/ids";

/**
 * M7 契约：match id 的形状。
 *
 * 上游把 match id 定义成 `<uuid>.<node>`，而**点号后面的那一段决定了这是哪一种对局**：
 * 空 node（`<uuid>.`）= 中继对局（服务端只转发），非空 = 权威对局（服务端跑 tick）。
 * 所以解析不是"随便切一刀"——`<uuid>.` 与 `<uuid>` 的差别是语义级的。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchLeave
 *
 * REQ-0001-018
 */

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("M7 契约: match id 的形状", () => {
  it("test_empty_node_means_a_relayed_match", () => {
    const parts = parseMatchId(`${UUID}.`);
    expect(parts).toEqual({ uuid: UUID, node: "" });
    expect(parts === null ? true : isAuthoritativeMatch(parts)).toBe(false);
  });

  it("test_non_empty_node_means_an_authoritative_match", () => {
    const parts = parseMatchId(`${UUID}.muster`);
    expect(parts).toEqual({ uuid: UUID, node: "muster" });
    expect(parts === null ? false : isAuthoritativeMatch(parts)).toBe(true);
  });

  it("test_uuid_is_lowercased_but_the_node_is_not", () => {
    expect(parseMatchId(`${UUID.toUpperCase()}.Node`)).toEqual({ uuid: UUID, node: "Node" });
  });

  it("test_a_missing_dot_is_rejected", () => {
    // 上游用 `strings.SplitN(..., ".", 2)` 要求两段——没有点号就是 `Invalid match ID`。
    expect(parseMatchId(UUID)).toBeNull();
    expect(parseMatchId("")).toBeNull();
  });

  it("test_a_leading_dot_is_rejected", () => {
    // `.muster` 会被切成 `["", "muster"]`：前半段不是 uuid。
    expect(parseMatchId(".muster")).toBeNull();
  });

  it("test_a_non_uuid_head_is_rejected", () => {
    expect(parseMatchId("not-a-uuid.")).toBeNull();
    expect(parseMatchId(`${UUID}x.`)).toBeNull();
  });

  it("test_extra_dots_stay_in_the_node_segment", () => {
    // 上游只切**第一刀**，所以点号后面的点号都属于 node。
    expect(parseMatchId(`${UUID}.a.b`)).toEqual({ uuid: UUID, node: "a.b" });
  });

  it("test_format_and_key_are_the_inverse_of_parse", () => {
    expect(formatMatchId(UUID, "muster")).toBe(`${UUID}.muster`);
    expect(formatMatchId(UUID)).toBe(`${UUID}.${LOCAL_NODE}`);
    expect(matchKeyOf("T-1", UUID)).toBe(`T-1|${UUID}`);
  });
});
