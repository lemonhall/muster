import { env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import type { MatchListFilters, MatchRecord } from "../../../src/domain/match/catalog";
import { listMatchRecords } from "../../../src/domain/match/store";
import { ask, closeAllMatchWorlds, matchJoinEnvelope, matchPost, matchWorld } from "../../helpers/match-world";

/**
 * M7 契约：权威对局的注册表（创建 → 加入 → 列表）。
 *
 * 上游这一批用例走 `LocalMatchRegistry`：`CreateMatch` 建一场权威对局、`JoinAttempt`
 * 加人、`ListMatches` 按标签/查询串把对局列出来。本项目把这三件事拆到两个地方：
 * 成员与标签住对局自己的 DO，列表读 `match_record` 表（ECN-0011 偏差 1/2）。
 * 于是这里的断言必须**真的**经过 DO 再落库——只看 `listMatches` 纯函数的单元测试
 * 证明不了"写进 D1 的那一行是对的"。
 *
 * 每个用例一个随机租户 = 一套全新的 D1 行与全新的 DO 存储。
 *
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndJoin
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndListMatches
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndListMatchesWithTokenizableLabel
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndListMatchesWithQuerying
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndListAllMatchesWithQueryStar
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndListMatchesWithQueryingArrays
 * 溯源: server/match_registry_test.go::TestMatchRegistryListMatchesAfterLabelsUpdate
 *
 * 契约源（机器可读）：
 * 契约源: server/match_registry.go::LocalMatchRegistry.JoinAttempt
 * 契约源: server/match_registry.go::LocalMatchRegistry.ListMatches
 * 契约源: server/match_registry.go::LocalMatchRegistry.UpdateMatchLabel
 *
 * REQ-0001-018
 */

afterAll(closeAllMatchWorlds);

/** 上游唯一的逻辑节点名，与 `LOCAL_NODE` 一致。 */
const NODE = "muster";

function filters(overrides: Partial<MatchListFilters> = {}): MatchListFilters {
  return {
    limit: 10,
    authoritative: undefined,
    label: undefined,
    minSize: undefined,
    maxSize: undefined,
    query: undefined,
    ...overrides,
  };
}

describe("M7 契约: 权威对局的注册表", () => {
  it("test_a_created_authoritative_match_can_be_joined", async () => {
    const world = await matchWorld();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", { authoritative: true, label: null, node: NODE });

    const socket = await world.open(crypto.randomUUID(), crypto.randomUUID(), "joiner");
    const reply = await ask(socket, matchJoinEnvelope("c1", { matchId: `${uuid}.${NODE}` }));

    expect(reply.message.case).toBe("match");
    if (reply.message.case !== "match") throw new Error("unreachable");
    expect(reply.message.value.matchId).toBe(`${uuid}.${NODE}`);
    expect(reply.message.value.authoritative).toBe(true);
    // "被接受了"最实在的证据是这条会话真的成了成员：人数从 1 开始涨。
    const listing = await listMatchRecords(env.DB, world.tenant, filters());
    expect(listing[0]?.size).toBe(1);
  });

  it("test_a_match_created_with_a_label_is_listed_by_that_label", async () => {
    const world = await matchWorld();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", { authoritative: true, label: "label", node: NODE });

    const listing = await listMatchRecords(env.DB, world.tenant, filters({ label: "label" }));
    expect(listing).toHaveLength(1);
    expect(listing[0]?.matchId).toBe(`${uuid}.${NODE}`);
    expect(listing[0]?.authoritative).toBe(true);
    // 另一个标签搜不到任何东西（不是"随便给个标签都返回"）。
    expect(await listMatchRecords(env.DB, world.tenant, filters({ label: "other" }))).toEqual([]);
  });

  it("test_a_tokenizable_label_is_compared_as_one_string", async () => {
    const world = await matchWorld();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", {
      authoritative: true,
      label: "label-part2",
      node: NODE,
    });

    expect(await listMatchRecords(env.DB, world.tenant, filters({ label: "label-part2" }))).toHaveLength(1);
    // 被分词器切开才会出现的"半串命中"必须搜不到——上游专门钉这条。
    expect(await listMatchRecords(env.DB, world.tenant, filters({ label: "part2" }))).toEqual([]);
  });

  it("test_the_query_string_wins_over_the_label_and_reads_the_json_label", async () => {
    const world = await matchWorld();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", {
      authoritative: true,
      label: '{"skill":60}',
      node: NODE,
    });

    // 两个参数一起给：`query` 生效、`label` 被忽略（上游 `queryString != nil` 那条）。
    const listing = await listMatchRecords(
      env.DB,
      world.tenant,
      filters({ label: "label", query: "+label.skill:>=50" }),
    );
    expect(listing.map((record) => record.matchId)).toEqual([`${uuid}.${NODE}`]);
    // 门槛不满足就搜不到（>=50 是当真的，不是"只要有个数字就行"）。
    expect(
      await listMatchRecords(env.DB, world.tenant, filters({ query: "+label.skill:>=70" })),
    ).toEqual([]);
  });

  it("test_the_star_query_lists_every_authoritative_match", async () => {
    const world = await matchWorld();
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", {
      authoritative: true,
      label: '{"skill":60}',
      node: NODE,
    });

    const listing = await listMatchRecords(env.DB, world.tenant, filters({ query: "*" }));
    expect(listing.map((record) => record.matchId)).toEqual([`${uuid}.${NODE}`]);
  });

  it("test_an_array_inside_the_label_is_queryable", async () => {
    const world = await matchWorld();
    const [one, two, three] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const uuid = crypto.randomUUID();
    await matchPost(world.match(uuid), "/create", {
      authoritative: true,
      label: `{"convo_ids": ["${one}", "${two}", "${three}"]}`,
      node: NODE,
    });

    const hit = await listMatchRecords(env.DB, world.tenant, filters({ query: `+label.convo_ids:${two}` }));
    expect(hit.map((record) => record.matchId)).toEqual([`${uuid}.${NODE}`]);
    // 不在数组里的 id 不命中。
    expect(
      await listMatchRecords(env.DB, world.tenant, filters({ query: `+label.convo_ids:${crypto.randomUUID()}` })),
    ).toEqual([]);
  });

  it("test_a_label_updated_after_creation_is_immediately_queryable", async () => {
    const world = await matchWorld();
    const uuid = crypto.randomUUID();
    const stub = world.match(uuid);
    await matchPost(stub, "/create", { authoritative: true, label: null, node: NODE });

    await matchPost(stub, "/label", { label: '{"updated_label": 1}' });

    const listing = await listMatchRecords(env.DB, world.tenant, filters({ query: "label.updated_label:1" }));
    expect(listing.map((record) => record.matchId)).toEqual([`${uuid}.${NODE}`]);
    // 更新前的空标签不再命中任何带字段的查询。
    const broken = (await listMatchRecords(env.DB, world.tenant, filters())) as readonly MatchRecord[];
    expect(broken[0]?.label).toBe('{"updated_label": 1}');
  });
});
