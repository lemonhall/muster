/**
 * 锦标赛的 6 条 REST 端点：
 *
 *   GET    /v2/tournament                                  目录（分类区间 + 起止时间）
 *   GET    /v2/tournament/{tournamentId}                   记录列表
 *   POST   /v2/tournament/{tournamentId}                   写分（swagger 里同时有 PUT）
 *   PUT    /v2/tournament/{tournamentId}                   写分（同一实现）
 *   DELETE /v2/tournament/{tournamentId}                   删掉自己的成绩
 *   POST   /v2/tournament/{tournamentId}/join              报名
 *   GET    /v2/tournament/{tournamentId}/owner/{ownerId}   某人附近的名次
 *
 * 三处必须照抄的细节：
 *   1. **id 空时的文案两条不一样**：记录列表与 haystack 用 `Tournament ID must be provided`
 *      （没有句号），写分/删分用 `Tournament ID must be provided.`（有句号）。
 *      上游就是这么写的，且逐字出现在 API 测试里；
 *   2. 记录列表的 `limit` 默认 **10**，haystack 的默认 **100**；
 *   3. 目录的 `category_end` / `end_time` / `limit` 三个参数各有独立的边界文案。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_tournament.go::ListTournaments
 * 契约源: server/api_tournament.go::ListTournamentRecords
 * 契约源: server/api_tournament.go::WriteTournamentRecord
 * 契约源: server/api_tournament.go::DeleteTournamentRecord
 * 契约源: server/api_tournament.go::JoinTournament
 * 契约源: server/api_tournament.go::ListTournamentRecordsAroundOwner
 *
 * REQ-0001-016
 */

import { json, queryList, queryOptionalInt, queryValue } from "../body";
import { invalidArgument, internal, notFound, permissionDenied, failedPrecondition } from "../errors";
import type { Router, UserContext } from "../router";
import { loadLeaderboard } from "../../domain/competitive/leaderboard/context";
import { listTournaments } from "../../domain/competitive/tournament/catalog";
import {
  tournamentRecordsHaystack,
  tournamentRecordsList,
} from "../../domain/competitive/tournament/records";
import { tournamentJoin } from "../../domain/competitive/tournament/join";
import {
  tournamentRecordDelete,
  tournamentRecordWrite,
} from "../../domain/competitive/tournament/write";
import { CompetitiveError } from "../../domain/competitive/errors";
import { normalizeUserId } from "../../realtime/identifiers";
import { recordBody, recordListBody, tournamentBody, tournamentListBody } from "../../wire/competitive";
import { catalogCanEnter, catalogFilters } from "./tournament-catalog";
import { recordInput } from "./competitive-body";

const NOT_FOUND = "Tournament not found.";
const INVALID_RECORD_LIMIT = "Invalid limit - limit must be between 1 and 100.";
const INVALID_OWNER_IDS = "One or more owner IDs are invalid.";

function nowOf(context: UserContext): Date {
  return new Date(context.tenantEnv.nowSec * 1000);
}

/** 领域失败 → 上游端点专属的 gRPC 错误。 */
function toApiError(error: unknown, deleting: boolean): never {
  if (error instanceof CompetitiveError) {
    switch (error.failure) {
      case "not-found":
      case "not-tournament":
        throw notFound(NOT_FOUND);
      case "ended":
        throw notFound("Tournament has ended.");
      case "authoritative":
        throw permissionDenied(
          deleting
            ? "Tournament only allows authoritative score deletions."
            : "Tournament only allows authoritative score submissions.",
        );
      case "max-size":
        throw failedPrecondition(
          deleting ? "Tournament not found." : "Tournament has reached max size.",
        );
      case "max-attempts":
        throw failedPrecondition("Reached allowed max number of score attempts.");
      case "join-required":
        throw failedPrecondition("Must join tournament before attempting to write value.");
      case "outside-duration":
        throw failedPrecondition("Tournament is not active and cannot accept new scores.");
      default:
        throw internal(deleting ? "Error deleting score from tournament." : "Error writing score to tournament.");
    }
  }
  throw error;
}

async function requireTournament(context: UserContext, id: string, message: string) {
  if (id === "") throw invalidArgument(message);
  return loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
}

export function registerTournamentRoutes(router: Router): void {
  router.handleUser("GET", "/v2/tournament", async (context) => {
    const bounds = catalogFilters(context);
    const result = await listTournaments(
      context.env.DB,
      context.tenantEnv.tenantId,
      bounds,
      nowOf(context),
    );
    return json(
      tournamentListBody(
        result.tournaments.map((board) => tournamentBody(catalogCanEnter(board, nowOf(context)))),
        result.cursor,
      ),
    );
  });

  router.handleUser("GET", "/v2/tournament/{tournamentId}", async (context) => {
    const id = context.params.tournamentId ?? "";
    const leaderboard = await requireTournament(context, id, "Tournament ID must be provided");
    const limit = queryOptionalInt(context.url, "limit", INVALID_RECORD_LIMIT);
    if (limit !== undefined && (limit < 1 || limit > 100)) throw invalidArgument(INVALID_RECORD_LIMIT);
    const cursor = queryValue(context.url, "cursor");
    const ownerIds = queryList(context.url, "ownerIds", "owner_ids").map((raw) => {
      const owner = normalizeUserId(raw);
      if (owner === null) throw invalidArgument(INVALID_OWNER_IDS);
      return owner;
    });
    const effectiveLimit = limit ?? (ownerIds.length === 0 || cursor === "" ? 10 : null);
    const expiry = queryOptionalInt(context.url, "expiry", "Invalid expiry - expiry must be an integer.");
    const result = await tournamentRecordsList(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      { limit: effectiveLimit, cursor, ownerIds, overrideExpiry: expiry ?? 0 },
      nowOf(context),
    ).catch((error: unknown) => toApiError(error, false));
    return json(recordListBody(result));
  });

  const write = async (context: UserContext): Promise<Response> => {
    const id = context.params.tournamentId ?? "";
    const input = await recordInput(context, id, "Tournament ID must be provided.");
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    if (leaderboard.endTime > 0 && leaderboard.endTime <= context.tenantEnv.nowSec) {
      throw notFound("Tournament not found or has ended.");
    }
    const record = await tournamentRecordWrite(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      input,
      nowOf(context),
    ).catch((error: unknown) => toApiError(error, false));
    return json(recordBody(record));
  };
  router.handleUser("POST", "/v2/tournament/{tournamentId}", write);
  router.handleUser("PUT", "/v2/tournament/{tournamentId}", write);

  router.handleUser("DELETE", "/v2/tournament/{tournamentId}", async (context) => {
    const id = context.params.tournamentId ?? "";
    if (id === "") throw invalidArgument("Invalid tournament ID.");
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    await tournamentRecordDelete(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      context.session.user.id,
      context.session.user.id,
      nowOf(context),
    ).catch((error: unknown) => toApiError(error, true));
    return json({});
  });

  router.handleUser("POST", "/v2/tournament/{tournamentId}/join", async (context) => {
    const id = context.params.tournamentId ?? "";
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    await tournamentJoin(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      context.session.user.id,
      context.session.user.username,
      nowOf(context),
    ).catch((error: unknown) => {
      if (error instanceof CompetitiveError && error.failure === "max-size") {
        throw invalidArgument("Tournament cannot be joined as it has reached its max size.");
      }
      if (error instanceof CompetitiveError && error.failure === "outside-duration") {
        throw invalidArgument("Tournament is not active and cannot accept new joins.");
      }
      if (error instanceof CompetitiveError) throw notFound(NOT_FOUND);
      throw error;
    });
    return json({});
  });

  router.handleUser("GET", "/v2/tournament/{tournamentId}/owner/{ownerId}", async (context) => {
    const id = context.params.tournamentId ?? "";
    const leaderboard = await requireTournament(context, id, "Invalid tournament ID.");
    if (leaderboard === null) throw notFound(NOT_FOUND);
    const limit = queryOptionalInt(context.url, "limit", INVALID_RECORD_LIMIT) ?? 100;
    if (limit < 1 || limit > 100) throw invalidArgument(INVALID_RECORD_LIMIT);
    const rawOwner = context.params.ownerId ?? "";
    if (rawOwner === "") throw invalidArgument("Owner ID must be provided for a haystack query.");
    const ownerId = normalizeUserId(rawOwner);
    if (ownerId === null) throw invalidArgument("Invalid owner ID provided.");
    const expiry = queryOptionalInt(context.url, "expiry", "Invalid expiry - expiry must be an integer.");
    const result = await tournamentRecordsHaystack(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      {
        cursor: queryValue(context.url, "cursor"),
        ownerId,
        limit,
        overrideExpiry: expiry ?? 0,
      },
      nowOf(context),
    ).catch((error: unknown) => toApiError(error, false));
    return json(recordListBody(result));
  });
}
