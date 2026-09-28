/**
 * 排行榜的 4 条 REST 端点：
 *
 *   GET    /v2/leaderboard/{leaderboardId}                    列出记录（可带 owner_ids）
 *   POST   /v2/leaderboard/{leaderboardId}                    写一条成绩
 *   DELETE /v2/leaderboard/{leaderboardId}                    删掉自己的成绩
 *   GET    /v2/leaderboard/{leaderboardId}/owner/{ownerId}    某人附近的名次
 *
 * 校验顺序照抄上游 `ApiServer.*`——顺序错了文案就会错：
 *   - 列表：id 空 → limit 范围 → owner_ids 合法性 → （领域层）榜单不存在 / 坏游标；
 *   - 写分：id 空 → record 为空 → metadata 不是 JSON 对象 → （领域层）不存在 / 越权；
 *   - 删分：id 空 → （领域层）不存在 / 是锦标赛 / 越权。
 *
 * `limit` 的默认值是**两条独立规则**，很容易抄错：
 *   - 列表：没给 limit 且（没有 owner_ids 或带了 cursor）→ 默认 1；给了 limit 就必须在 1..1000；
 *   - owner 附近：没给 limit → 默认 1，给了必须在 1..100。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_leaderboard.go::ListLeaderboardRecords
 * 契约源: server/api_leaderboard.go::WriteLeaderboardRecord
 * 契约源: server/api_leaderboard.go::DeleteLeaderboardRecord
 * 契约源: server/api_leaderboard.go::ListLeaderboardRecordsAroundOwner
 *
 * REQ-0001-015
 */

import { json, queryList, queryOptionalInt, queryValue } from "../body";
import { invalidArgument, internal, notFound, permissionDenied } from "../errors";
import type { Router, UserContext } from "../router";
import { loadLeaderboard } from "../../domain/competitive/leaderboard/context";
import { leaderboardRecordsList } from "../../domain/competitive/leaderboard/list";
import { leaderboardRecordsHaystack } from "../../domain/competitive/leaderboard/haystack";
import {
  leaderboardRecordDelete,
  leaderboardRecordWrite,
} from "../../domain/competitive/leaderboard/write";
import { CompetitiveError } from "../../domain/competitive/errors";
import { normalizeUserId } from "../../realtime/identifiers";
import { recordBody, recordListBody } from "../../wire/competitive";
import { recordInput } from "./competitive-body";

const INVALID_ID = "Invalid leaderboard ID.";
const INVALID_LIST_LIMIT = "Invalid limit - limit must be between 1 and 1000.";
const INVALID_OWNER_LIMIT = "Invalid limit - limit must be between 1 and 100.";
const INVALID_OWNER_IDS = "One or more owner IDs are invalid.";
const NOT_FOUND = "Leaderboard not found.";

/** 领域失败 → 上游端点专属的 gRPC 错误。文案按端点分，所以映射放在这里。 */
function toApiError(error: unknown, deleting: boolean): never {
  if (error instanceof CompetitiveError) {
    switch (error.failure) {
      case "not-found":
      case "not-tournament":
        throw notFound(NOT_FOUND);
      case "authoritative":
        throw permissionDenied(
          deleting
            ? "Leaderboard only allows authoritative score deletions."
            : "Leaderboard only allows authoritative score submissions.",
        );
      default:
        throw internal(deleting ? "Error deleting score from leaderboard." : "Error writing score to leaderboard.");
    }
  }
  throw error;
}

function nowOf(context: UserContext): Date {
  return new Date(context.tenantEnv.nowSec * 1000);
}

export function registerLeaderboardRoutes(router: Router): void {
  router.handleUser("GET", "/v2/leaderboard/{leaderboardId}", async (context) => {
    const id = context.params.leaderboardId ?? "";
    if (id === "") throw invalidArgument(INVALID_ID);
    const limit = queryOptionalInt(context.url, "limit", INVALID_LIST_LIMIT);
    if (limit !== undefined && (limit < 1 || limit > 1000)) throw invalidArgument(INVALID_LIST_LIMIT);
    const cursor = queryValue(context.url, "cursor");
    const rawOwners = queryList(context.url, "ownerIds", "owner_ids");
    const ownerIds = rawOwners.map((raw) => {
      const owner = normalizeUserId(raw);
      if (owner === null) throw invalidArgument(INVALID_OWNER_IDS);
      return owner;
    });
    const effectiveLimit = limit ?? (ownerIds.length === 0 || cursor !== "" ? 1 : null);
    const expiry = queryOptionalInt(context.url, "expiry", "Invalid expiry - expiry must be an integer.");
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    const result = await leaderboardRecordsList(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      {
        limit: effectiveLimit,
        cursor,
        ownerIds,
        overrideExpiry: expiry ?? 0,
      },
      nowOf(context),
    );
    return json(recordListBody(result));
  });

  router.handleUser("POST", "/v2/leaderboard/{leaderboardId}", async (context) => {
    const id = context.params.leaderboardId ?? "";
    const input = await recordInput(context, id, INVALID_ID);
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    const record = await leaderboardRecordWrite(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      input,
      nowOf(context),
    ).catch((error: unknown) => toApiError(error, false));
    return json(recordBody(record));
  });

  router.handleUser("DELETE", "/v2/leaderboard/{leaderboardId}", async (context) => {
    const id = context.params.leaderboardId ?? "";
    if (id === "") throw invalidArgument(INVALID_ID);
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    await leaderboardRecordDelete(
      context.env.DB,
      context.tenantEnv.tenantId,
      leaderboard,
      context.session.user.id,
      context.session.user.id,
      nowOf(context),
    ).catch((error: unknown) => toApiError(error, true));
    return json({});
  });

  router.handleUser("GET", "/v2/leaderboard/{leaderboardId}/owner/{ownerId}", async (context) => {
    const id = context.params.leaderboardId ?? "";
    if (id === "") throw invalidArgument(INVALID_ID);
    const limit = queryOptionalInt(context.url, "limit", INVALID_OWNER_LIMIT) ?? 1;
    if (limit < 1 || limit > 100) throw invalidArgument(INVALID_OWNER_LIMIT);
    const rawOwner = context.params.ownerId ?? "";
    if (rawOwner === "") throw invalidArgument("Owner ID must be provided for a haystack query.");
    const ownerId = normalizeUserId(rawOwner);
    if (ownerId === null) throw invalidArgument("Invalid owner ID provided.");
    const expiry = queryOptionalInt(context.url, "expiry", "Invalid expiry - expiry must be an integer.");
    const leaderboard = await loadLeaderboard(context.env.DB, context.tenantEnv.tenantId, id);
    if (leaderboard === null) throw notFound(NOT_FOUND);
    const result = await leaderboardRecordsHaystack(
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
    );
    return json(recordListBody(result));
  });
}
