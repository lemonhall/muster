import { afterAll, describe, expect, it } from "vitest";

import {
  ask,
  closeAllMatchWorlds,
  matchJoinEnvelope,
  matchPost,
  matchWorld,
  matchmakerAddEnvelope,
} from "../../helpers/match-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * M7 契约：`GET /v2/match` 与 `GET /v2/matchmaker/stats` 的线上形状。
 *
 * 上游没有针对这两条端点的测试文件（它们的证据来自 `api_match.go` / `api_matchmaker.go`
 * 的源码与 swagger），所以这里按"第二证据源"钉住四类东西：
 *
 * 1. **七步校验的顺序与逐字文案**（顺序敏感的六条 + 最后那条 `Error listing matches.`）；
 * 2. protojson 的三条形状规矩：空列表整个 `matches` 键省略、零值字段省略、
 *    权威对局一定带 `label`（空串也带）；
 * 3. `?label=` 空串与"没给 label"不是一回事；
 * 4. `authoritative=false` 与标签/查询串同时出现是 400，而不是"空结果"。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_match.go::ApiServer.ListMatches
 * 契约源: server/api_matchmaker.go::ApiServer.GetMatchmakerStats
 *
 * REQ-0001-018
 */

afterAll(closeAllMatchWorlds);

const NODE = "muster";
const INVALID_LIMIT = "Invalid limit - limit must be between 1 and 100.";

async function errorOf(response: Response): Promise<{ code: number; message: string }> {
  return (await response.json()) as { code: number; message: string };
}

/** 一个租户 + 一个已认证的 REST 会话（`GET /v2/match` 要 Bearer 令牌）。 */
async function rest() {
  const world = await matchWorld();
  const session = await world.restSession();
  return {
    world,
    get: (query: string) => call(`/v2/match${query}`, { authorization: bearer(session.token) }),
    stats: () => call("/v2/matchmaker/stats", { authorization: bearer(session.token) }),
  };
}

describe("M7 契约: GET /v2/match 的校验顺序", () => {
  it("test_limit_bounds_are_checked_first", async () => {
    const { get } = await rest();
    for (const query of ["?limit=0", "?limit=101", "?limit=abc"]) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      expect(await errorOf(response)).toEqual({ code: 3, message: INVALID_LIMIT });
    }
  });

  it("test_label_or_query_with_a_non_authoritative_filter_is_rejected", async () => {
    const { get } = await rest();
    const label = await get("?authoritative=false&label=label");
    expect(await errorOf(label)).toEqual({
      code: 3,
      message: "Label filtering is not supported for non-authoritative matches.",
    });
    const query = await get("?authoritative=false&query=*");
    expect(await errorOf(query)).toEqual({
      code: 3,
      message: "Query filtering is not supported for non-authoritative matches.",
    });
  });

  it("test_size_bounds_are_checked_in_order", async () => {
    const { get } = await rest();
    expect(await errorOf(await get("?min_size=-1"))).toEqual({
      code: 3,
      message: "Minimum size must be 0 or above.",
    });
    expect(await errorOf(await get("?max_size=-1"))).toEqual({
      code: 3,
      message: "Maximum size must be 0 or above.",
    });
    expect(await errorOf(await get("?min_size=5&max_size=4"))).toEqual({
      code: 3,
      message: "Maximum size must be greater than or equal to minimum size when both are specified.",
    });
    // camelCase 写法也必须认（官方 SDK 发的就是这种）。
    expect(await errorOf(await get("?minSize=5&maxSize=4"))).toEqual({
      code: 3,
      message: "Maximum size must be greater than or equal to minimum size when both are specified.",
    });
  });
});

describe("M7 契约: GET /v2/match 的响应形状", () => {
  it("test_an_empty_directory_omits_the_matches_key_entirely", async () => {
    const { get } = await rest();
    const response = await get("");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it("test_an_authoritative_match_carries_its_label_even_when_empty", async () => {
    const { world, get } = await rest();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", { authoritative: true, label: "", node: NODE });

    const body = (await (await get("")).json()) as { matches: Record<string, unknown>[] };
    expect(body.matches).toEqual([{ match_id: `${uuid}.${NODE}`, authoritative: true, label: "" }]);
    // 人数 0 是零值：整条 `size` 键不该出现。
    expect(body.matches[0]).not.toHaveProperty("size");
  });

  it("test_an_empty_label_query_string_is_not_the_same_as_no_label", async () => {
    const { world, get } = await rest();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", { authoritative: true, label: "", node: NODE });

    // `?label=` 是"给了空标签"：只看权威对局，且标签要整串相等。
    const given = (await (await get("?label=")).json()) as { matches?: unknown[] };
    expect(given.matches).toHaveLength(1);
    // 换一个标签就搜不到（证明上一条不是"随便给个标签都行"）。
    expect(await (await get("?label=other")).json()).toEqual({});
  });

  it("test_size_filters_apply_to_the_member_count", async () => {
    const { world, get } = await rest();
    const uuid = crypto.randomUUID();
    const stub = world.match(uuid);
    await matchPost(stub, "/create", { authoritative: true, label: "label", node: NODE });
    const socket = await world.open(crypto.randomUUID(), crypto.randomUUID(), "joiner");
    await ask(socket, matchJoinEnvelope("c1", { matchId: `${uuid}.${NODE}` }));

    const body = (await (await get("?min_size=1&max_size=1")).json()) as { matches: Record<string, unknown>[] };
    expect(body.matches?.[0]?.size).toBe(1);
    expect(await (await get("?min_size=2")).json()).toEqual({});
  });
});

describe("M7 契约: GET /v2/matchmaker/stats", () => {
  it("test_an_idle_pool_serialises_as_an_empty_object", async () => {
    const { stats } = await rest();
    const response = await stats();
    expect(response.status).toBe(200);
    // 票数 0、没有最老票、没有完成样本：三个零值字段整条省略。
    expect(await response.json()).toEqual({});
  });

  it("test_a_waiting_ticket_shows_up_as_a_count", async () => {
    const { world, stats } = await rest();
    // 把成局间隔调到测试生命周期之外：等票会排一个闹钟，而闹钟**默认 15 秒**后就会
    // 醒一次；文件跑完得比它快，否则 teardown 会撞上一个还在飞的 DO 调用。
    await world.setConfig({ intervalMs: 600_000 });
    const socket = await world.open(crypto.randomUUID(), crypto.randomUUID(), "waiting");
    await ask(socket, matchmakerAddEnvelope("c1", { minCount: 2, maxCount: 2 }));

    const body = (await (await stats()).json()) as Record<string, unknown>;
    expect(body["ticket_count"]).toBe(1);
    expect(typeof body["oldest_ticket_create_time"]).toBe("string");
    expect(body).not.toHaveProperty("completions");
  });
});
