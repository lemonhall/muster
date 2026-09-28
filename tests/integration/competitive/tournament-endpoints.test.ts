import { describe, expect, it } from "vitest";

import { errorBody, socialWorld, type SocialAccount, type SocialWorld } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";
import {
  makeLeaderboard,
  makeTournament,
  readSize,
  writeScore,
} from "../../helpers/competitive-world";

/**
 * 锦标赛目录、报名与校验文案。
 *
 * 这一组不是搬运上游的某条用例（上游把锦标赛的 REST 面只测了 haystack 一条），
 * 而是**第二证据源**：文案与边界值逐条取自 `server/api_tournament.go` 与
 * `apigrpc/apigrpc.swagger.json` 的路径表。判定仍是"能观察到什么"——状态码、
 * 错误体、以及报名之后库里/目录里真的变了。
 *
 * 契约源: server/api_tournament.go::ListTournaments
 * 契约源: server/api_tournament.go::JoinTournament
 * 契约源: server/api_tournament.go::WriteTournamentRecord
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/tournament
 */

function catalog(
  account: SocialAccount,
  query = "",
): Promise<Response> {
  return call(`/v2/tournament${query}`, { authorization: bearer(account.token) });
}

function join(account: SocialAccount, id: string): Promise<Response> {
  return call(`/v2/tournament/${id}/join`, {
    method: "POST",
    authorization: bearer(account.token),
  });
}

async function expectError(response: Response, status: number, message: string): Promise<void> {
  expect(response.status).toBe(status);
  expect((await errorBody(response)).message).toBe(message);
}

describe("锦标赛目录参数校验", () => {
  it("四条边界文案逐条对上", async () => {
    const world = await socialWorld(1);
    const account = world.accounts[0] as SocialAccount;

    await expectError(
      await catalog(account, "?categoryEnd=128"),
      400,
      "Tournament category end must be >=0 and <128.",
    );
    await expectError(
      await catalog(account, "?categoryStart=5&categoryEnd=3"),
      400,
      "Tournament category end must be greater than category start.",
    );
    await expectError(
      await catalog(account, "?startTime=100&endTime=50"),
      400,
      "Tournament end time must be greater than start time.",
    );
    await expectError(await catalog(account, "?limit=0"), 400, "Limit must be between 1 and 100.");
  });

  it("默认只看未结束的锦标赛，并且带上 can_enter", async () => {
    const world = await socialWorld(1);
    const account = world.accounts[0] as SocialAccount;
    const now = Math.floor(Date.now() / 1000);
    const live = await makeTournament(world, now);
    // 已经结束的锦标赛：`end_time` 落在过去。
    await makeLeaderboard(world, {
      duration: 7200,
      start_time: now - 7200,
      end_time: now - 60,
      sort_order: 1,
      enable_ranks: 1,
    });

    const body = (await (await catalog(account)).json()) as {
      tournaments?: readonly { id: string; can_enter?: boolean; duration?: number }[];
    };

    const ids = (body.tournaments ?? []).map((entry) => entry.id);
    expect(ids).toContain(live);
    expect(ids).toHaveLength(1);
    expect((body.tournaments ?? [])[0]?.can_enter).toBe(true);
    expect((body.tournaments ?? [])[0]?.duration).toBe(7200);
  });
});

describe("锦标赛报名", () => {
  async function joinRequiredTournament(
    maxSize = 0,
  ): Promise<{ world: SocialWorld; id: string; first: SocialAccount; second: SocialAccount }> {
    const world = await socialWorld(2);
    const id = await makeLeaderboard(world, {
      duration: 7200,
      start_time: Math.floor(Date.now() / 1000) - 3600,
      sort_order: 1,
      operator: 0,
      enable_ranks: 1,
      join_required: 1,
      max_size: maxSize,
    });
    return {
      world,
      id,
      first: world.accounts[0] as SocialAccount,
      second: world.accounts[1] as SocialAccount,
    };
  }

  it("要求报名时：没报名不能写分，报名之后才行", async () => {
    const { id, first } = await joinRequiredTournament();

    await expectError(
      await call(`/v2/tournament/${id}`, {
        method: "POST",
        authorization: bearer(first.token),
        body: { record: { score: 1, subscore: 2 } },
      }),
      400,
      "Must join tournament before attempting to write value.",
    );

    expect((await join(first, id)).status).toBe(200);
    expect((await join(first, id)).status).toBe(200); // 重复报名是幂等的空操作
    const record = await writeScore("tournament", first, id, 1, 2);
    expect(record.score).toBe("1");
  });

  it("名额上限：第二个报名的人被拒，且不占位", async () => {
    const { world, id, first, second } = await joinRequiredTournament(1);

    expect((await join(first, id)).status).toBe(200);
    await expectError(
      await join(second, id),
      400,
      "Tournament cannot be joined as it has reached its max size.",
    );

    expect(await readSize(world.tenant, id)).toBe(1);
  });

  it("重复报名不重复占位，目录里的 size 也停在 1", async () => {
    const { world, id, first } = await joinRequiredTournament(2);

    expect((await join(first, id)).status).toBe(200);
    expect((await join(first, id)).status).toBe(200);

    expect(await readSize(world.tenant, id)).toBe(1);
    const body = (await (await catalog(first, "?limit=100")).json()) as {
      tournaments?: readonly { id: string; size?: number }[];
    };
    expect((body.tournaments ?? []).find((entry) => entry.id === id)?.size).toBe(1);
  });
});

describe("锦标赛写分的越权与不存在", () => {
  it("权威榜拒绝普通调用者写分", async () => {
    const world = await socialWorld(1);
    const account = world.accounts[0] as SocialAccount;
    const id = await makeLeaderboard(world, {
      duration: 7200,
      start_time: Math.floor(Date.now() / 1000) - 3600,
      sort_order: 1,
      authoritative: 1,
      enable_ranks: 1,
    });

    const response = await call(`/v2/tournament/${id}`, {
      method: "POST",
      authorization: bearer(account.token),
      body: { record: { score: 1, subscore: 2 } },
    });

    await expectError(response, 403, "Tournament only allows authoritative score submissions.");
  });

  it("不存在的锦标赛：读列表、报名、写分都是 404", async () => {
    const world = await socialWorld(1);
    const account = world.accounts[0] as SocialAccount;
    const missing = crypto.randomUUID();

    await expectError(
      await call(`/v2/tournament/${missing}`, { authorization: bearer(account.token) }),
      404,
      "Tournament not found.",
    );
    await expectError(await join(account, missing), 404, "Tournament not found.");
    await expectError(
      await call(`/v2/tournament/${missing}`, {
        method: "POST",
        authorization: bearer(account.token),
        body: { record: { score: 1, subscore: 2 } },
      }),
      404,
      "Tournament not found.",
    );
  });
});
