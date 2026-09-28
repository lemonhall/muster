import { afterEach, describe, expect, it } from "vitest";

import { partyCreateFrame } from "../../helpers/party-frames";
import { OWNER, ask, partyIdOf, partyWorld, type PartyWorld } from "../../helpers/party-world";
import { authenticateDeviceOrFail, bearer, call } from "../../helpers/tenants";

// M8 派对目录 `GET /v2/party`：真实 HTTP → 路由 → D1 的整条链路。
//
// 上游 `ApiServer.ListParties` 的契约：
//   - `limit` 不在 1..100 就是 `InvalidArgument`，文案逐字；
//   - `open` 三态（不给 / false / true）；
//   - `query` 空串被规整成 `*`；
//   - **隐藏派对不进目录**（`showHidden` 恒为 false）；
//   - 解游标失败与查询失败一律 `Internal` + `Error listing matches.`。
//
// 契约源（机器可读）：
// 契约源: server/api_party.go::ApiServer.ListParties
//
// REQ-0001-019

let world: PartyWorld | null = null;

afterEach(async () => {
  await world?.closeAll();
  world = null;
});

interface ListedParty {
  readonly party_id: string;
  readonly open?: boolean;
  readonly hidden?: boolean;
  readonly max_size?: number;
  readonly label?: string;
}

interface Page {
  readonly parties?: readonly ListedParty[];
  readonly cursor?: string;
}

async function signIn(target: PartyWorld): Promise<string> {
  const session = await authenticateDeviceOrFail(
    { id: target.tenant, serverKey: target.serverKey },
    `listing-${crypto.randomUUID().slice(0, 8)}`,
  );
  return bearer(session.token);
}

async function list(
  target: PartyWorld,
  token: string,
  query = "",
): Promise<{ readonly status: number; readonly body: Page & { code?: number; message?: string } }> {
  const response = await call(`/v2/party${query}`, { authorization: token });
  return { status: response.status, body: (await response.json()) as Page };
}

describe("M8 目录: 列表与过滤", () => {
  it("test_open_parties_show_up_and_hidden_ones_do_not", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const token = await signIn(world);

    const eu = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4, label: '{"region":"eu"}' })),
    ).partyId;
    const na = partyIdOf(
      await ask(owner, partyCreateFrame("c2", { open: true, maxSize: 6, label: '{"region":"na"}' })),
    ).partyId;
    const secret = partyIdOf(
      await ask(owner, partyCreateFrame("c3", { open: true, maxSize: 2, hidden: true })),
    ).partyId;

    const page = await list(world, token);
    expect(page.status).toBe(200);
    const ids = (page.body.parties ?? []).map((one) => one.party_id);
    expect(ids).toContain(eu);
    expect(ids).toContain(na);
    expect(ids).not.toContain(secret);

    // 零值省略 + 标签原样回。`hidden` 在目录里永远是 false，所以这一位不出现。
    const euEntry = (page.body.parties ?? []).find((one) => one.party_id === eu);
    expect(euEntry).toEqual({
      party_id: eu,
      open: true,
      max_size: 4,
      label: '{"region":"eu"}',
    });
  });

  it("test_the_query_and_open_filters_narrow_the_list", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const token = await signIn(world);
    const eu = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4, label: '{"region":"eu"}' })),
    ).partyId;
    await ask(owner, partyCreateFrame("c2", { open: false, maxSize: 4, label: '{"region":"na"}' }));

    const byLabel = await list(world, token, "?query=%2Blabel.region%3Aeu");
    expect((byLabel.body.parties ?? []).map((one) => one.party_id)).toEqual([eu]);

    const openOnly = await list(world, token, "?open=true");
    expect((openOnly.body.parties ?? []).map((one) => one.party_id)).toEqual([eu]);

    const closedOnly = await list(world, token, "?open=false");
    expect((closedOnly.body.parties ?? []).length).toBe(1);

    // 一个都不命中时整个 `parties` 键省略（protojson 对 repeated 的规矩）。
    const nothing = await list(world, token, "?query=%2Blabel.region%3Aap");
    expect(nothing.body).toEqual({});
  });

  it("test_the_limit_is_validated_with_the_upstream_wording", async () => {
    world = await partyWorld();
    const token = await signIn(world);
    for (const raw of ["0", "101", "-3"]) {
      const page = await list(world, token, `?limit=${raw}`);
      expect(page.status).toBe(400);
      expect(page.body).toEqual({
        code: 3,
        message: "Invalid limit - limit must be between 1 and 100.",
      });
    }
  });
});

describe("M8 目录: 翻页", () => {
  it("test_paging_returns_every_party_once", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const token = await signIn(world);
    for (const index of [1, 2, 3]) {
      await ask(owner, partyCreateFrame(`c${index}`, { open: true, maxSize: 4, label: `{"n":${index}}` }));
    }

    const first = await list(world, token, "?limit=2");
    expect((first.body.parties ?? []).length).toBe(2);
    expect(first.body.cursor).toBeTruthy();

    const second = await list(world, token, `?limit=2&cursor=${encodeURIComponent(first.body.cursor ?? "")}`);
    expect((second.body.parties ?? []).length).toBe(1);
    // 最后一页不再给游标。
    expect(second.body.cursor).toBeUndefined();

    const seen = [
      ...(first.body.parties ?? []).map((one) => one.party_id),
      ...(second.body.parties ?? []).map((one) => one.party_id),
    ];
    expect(new Set(seen).size).toBe(3);
  });

  it("test_a_cursor_from_another_filter_is_an_internal_error", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const token = await signIn(world);
    await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 }));
    await ask(owner, partyCreateFrame("c2", { open: true, maxSize: 4 }));

    const first = await list(world, token, "?limit=1");
    const stale = first.body.cursor ?? "";
    const page = await list(world, token, `?limit=2&cursor=${encodeURIComponent(stale)}`);
    expect(page.status).toBe(500);
    expect(page.body).toEqual({ code: 13, message: "Error listing matches." });
  });

  it("test_a_garbage_cursor_is_an_internal_error_not_a_bad_request", async () => {
    world = await partyWorld();
    const token = await signIn(world);
    const page = await list(world, token, "?cursor=not-a-cursor");
    expect(page.status).toBe(500);
    expect(page.body).toEqual({ code: 13, message: "Error listing matches." });
  });
});
