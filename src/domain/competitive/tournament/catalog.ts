/**
 * 锦标赛目录：`GET /v2/tournament`。
 *
 * 上游把锦标赛列表放在 `LeaderboardCache` 的插入序切片里，所以它天然是"创建顺序"；
 * 本项目按 `(create_time, id)` 排——同一个顺序，只是把"内存里的顺序"换成"库里的顺序"。
 * 游标同样编码成 base64url(JSON)，对客户端仍然是不透明字符串（ECN-0004 的同一决定）。
 *
 * 一处刻意不同：坏游标上游会变成 500 `Error listing tournaments.`（`TournamentList`
 * 的任何错误都被那一个分支吞掉）。本项目回 400 `Cursor is invalid or expired.`——
 * 客户端自己的输入错了却被报成服务端故障，是上游的一处疏漏。登记在 ECN-0010 偏差 9。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_tournament.go::ListTournaments
 * 契约源: server/core_tournament.go::TournamentList
 */

import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../../base64url";
import { invalidArgument } from "../../../http/errors";
import { toLeaderboard, type Leaderboard } from "../leaderboard/definition";
import { listTournamentRows } from "../leaderboard/store";

const INVALID_CURSOR = "Cursor is invalid or expired.";

interface ListCursor {
  readonly createTime: number;
  readonly id: string;
}

export interface TournamentListFilters {
  readonly categoryStart: number;
  readonly categoryEnd: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly limit: number;
  readonly cursor: string;
}

export interface TournamentListResult {
  readonly tournaments: readonly Leaderboard[];
  readonly cursor: string;
}

function decodeCursor(raw: string): ListCursor | null {
  if (raw === "") return null;
  if (raw.length > MAX_CURSOR_LENGTH) throw invalidArgument(INVALID_CURSOR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgument(INVALID_CURSOR);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.createTime !== "number") {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (!Number.isInteger(record.createTime)) throw invalidArgument(INVALID_CURSOR);
  return { createTime: record.createTime, id: record.id };
}

export async function listTournaments(
  db: D1Database,
  tenantId: string,
  filters: TournamentListFilters,
  now: Date,
): Promise<TournamentListResult> {
  const rows = await listTournamentRows(db, tenantId, {
    categoryStart: filters.categoryStart,
    categoryEnd: filters.categoryEnd,
    startTime: filters.startTime,
    endTime: filters.endTime,
    limit: filters.limit,
    now: Math.floor(now.getTime() / 1000),
    cursor: decodeCursor(filters.cursor),
  });
  const overflowed = rows.length > filters.limit;
  const page = overflowed ? rows.slice(0, filters.limit) : rows;
  const last = page[page.length - 1];
  return {
    tournaments: page.map((row) => toLeaderboard(row)),
    cursor:
      overflowed && last !== undefined
        ? toBase64Url(JSON.stringify({ createTime: last.create_time, id: last.id }))
        : "",
  };
}
