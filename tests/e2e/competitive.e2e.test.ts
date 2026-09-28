import { describe, expect, it } from "vitest";

import { e2eTenant } from "./global-setup";
import {
  authenticateDevice,
  call,
  expectStatus,
  freshDeviceId,
  type SessionBody,
} from "./http-helpers";

/**
 * M6 E2E：排行榜与锦标赛的 REST 面，走真实 HTTP 通道。
 *
 * 为什么这条 E2E 只断言"没找到 / 参数不合法"这一半：上游**没有**排行榜与锦标赛的
 * 创建端点——榜是由服务端运行时（Lua/Go 模块里的 `leaderboard_create`）建出来的，
 * 而本项目的运行时模块面还没做（M8 的范围）。所以 E2E 能覆盖的真实链路是
 * "路由挂上了、鉴权生效、错误形状对、参数校验文案对"，而"有榜之后怎么读写"
 * 由集成测试逐条断言（那里可以直接种数据）。
 *
 * 目标是一个本地 `wrangler dev --local` 进程（见 `global-setup.ts`），
 * 不连接任何 Cloudflare 账号资源，因此不产生账单。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/leaderboard/{leaderboardId}
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/tournament
 * 契约源: server/api_leaderboard.go::ListLeaderboardRecords
 * 契约源: server/api_tournament.go::ListTournaments
 *
 * REQ-0001-015, REQ-0001-016
 */

async function newPlayer(): Promise<SessionBody> {
  const device = freshDeviceId("competitive");
  const session = await authenticateDevice(e2eTenant, device);
  return session.session;
}

describe("M6 E2E: 竞技面（真实 HTTP）", () => {
  it("test_leaderboard_routes_are_registered_and_report_not_found", async () => {
    const player = await newPlayer();
    const missing = crypto.randomUUID();

    await expectStatus(
      await call(`/v2/leaderboard/${missing}`, { token: player.token }),
      404,
      5,
      "Leaderboard not found.",
    );
    await expectStatus(
      await call(`/v2/leaderboard/${missing}`, {
        token: player.token,
        body: { record: { score: 1, subscore: 2 } },
      }),
      404,
      5,
      "Leaderboard not found.",
    );
    await expectStatus(
      await call(`/v2/leaderboard/${missing}`, { token: player.token, method: "DELETE" }),
      404,
      5,
      "Leaderboard not found.",
    );
    await expectStatus(
      await call(`/v2/leaderboard/${missing}/owner/${missing}`, { token: player.token }),
      404,
      5,
      "Leaderboard not found.",
    );
  });

  it("test_leaderboard_write_validates_the_record_before_looking_it_up", async () => {
    const player = await newPlayer();
    const missing = crypto.randomUUID();

    // 没有 `record` 字段 → 400，而不是 404：上游先解请求体，再查榜。
    await expectStatus(
      await call(`/v2/leaderboard/${missing}`, { token: player.token, body: {} }),
      400,
      3,
      "Invalid input, record score value is required.",
    );
    // `metadata` 不是 JSON 对象 → 400。
    await expectStatus(
      await call(`/v2/leaderboard/${missing}`, {
        token: player.token,
        body: { record: { score: 1, metadata: "[1,2]" } },
      }),
      400,
      3,
      "Metadata value must be JSON, if provided.",
    );
    // `limit` 越界 → 400，文案是列表端点专属的那句。
    await expectStatus(
      await call(`/v2/leaderboard/${missing}?limit=1001`, { token: player.token }),
      400,
      3,
      "Invalid limit - limit must be between 1 and 1000.",
    );
  });

  it("test_tournament_catalog_and_not_found_messages", async () => {
    const player = await newPlayer();
    const missing = crypto.randomUUID();

    // 目录：没有锦标赛时是空响应体，而不是 `{"tournaments":[]}`。
    const catalog = await call("/v2/tournament", { token: player.token });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({});

    await expectStatus(
      await call("/v2/tournament?limit=0", { token: player.token }),
      400,
      3,
      "Limit must be between 1 and 100.",
    );
    await expectStatus(
      await call("/v2/tournament?categoryEnd=128", { token: player.token }),
      400,
      3,
      "Tournament category end must be >=0 and <128.",
    );
    await expectStatus(
      await call(`/v2/tournament/${missing}`, { token: player.token }),
      404,
      5,
      "Tournament not found.",
    );
    await expectStatus(
      await call(`/v2/tournament/${missing}/join`, { token: player.token, method: "POST" }),
      404,
      5,
      "Tournament not found.",
    );
    await expectStatus(
      await call(`/v2/tournament/${missing}`, {
        token: player.token,
        body: { record: { score: 1, subscore: 2 } },
      }),
      404,
      5,
      "Tournament not found.",
    );
    await expectStatus(
      await call(`/v2/tournament/${missing}/owner/${missing}`, { token: player.token }),
      404,
      5,
      "Tournament not found.",
    );
  });

  it("test_competitive_routes_require_a_bearer_token", async () => {
    await expectStatus(await call("/v2/leaderboard/whatever"), 401, 16, "Auth token required");
    await expectStatus(await call("/v2/tournament?limit=1"), 401, 16, "Auth token required");
  });
});
