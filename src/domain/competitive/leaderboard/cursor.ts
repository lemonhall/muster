/**
 * 排行榜记录列表的游标。
 *
 * 上游是 `base64.RawURLEncoding(gob(leaderboardRecordListCursor))`；本项目沿用
 * base64url(JSON)（ECN-0004 的同一决定）。游标对客户端不可解析，所以能被观察到的
 * 只有两条：坏游标 → `400 {"code":3,"message":"Cursor is invalid or expired."}`；
 * 以及"换了排行榜/换了期数再拿旧游标"同样是这个错。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_leaderboard.go::unmarshalLeaderboardRecordsListCursor
 * 契约源: server/core_leaderboard.go::marshalLeaderboardRecordsListCursor
 */

import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../../base64url";
import { invalidArgument } from "../../../http/errors";

export interface RecordListCursor {
  /** `true` 表示这是"往下翻"的游标，`false` 表示"往上翻"。 */
  readonly isNext: boolean;
  readonly leaderboardId: string;
  readonly expiryTime: number;
  readonly score: number;
  readonly subscore: number;
  readonly ownerId: string;
  readonly rank: number;
}

const INVALID_CURSOR = "Cursor is invalid or expired.";

export function encodeRecordCursor(cursor: RecordListCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/**
 * 解码并校验游标。
 *
 * 上游校验三件事：`leaderboardId` 与 `expiryTime` 必须与本次请求一致，
 * 否则就是"拿别人的游标来翻页"。这两条不是防御性的过度设计——它们让
 * "列表已经过期、游标还留着"这种情况报出明确的错误，而不是悄悄给出错误的分页。
 */
export function decodeRecordCursor(
  raw: string,
  leaderboardId: string,
  expiryTime: number,
): RecordListCursor {
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
  const isNext = record.isNext;
  const fields = [record.score, record.subscore, record.rank, record.expiryTime];
  if (typeof isNext !== "boolean") throw invalidArgument(INVALID_CURSOR);
  if (typeof record.leaderboardId !== "string" || typeof record.ownerId !== "string") {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (fields.some((value) => typeof value !== "number" || !Number.isInteger(value))) {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (record.leaderboardId !== leaderboardId || record.expiryTime !== expiryTime) {
    throw invalidArgument(INVALID_CURSOR);
  }
  return {
    isNext,
    leaderboardId,
    expiryTime,
    score: record.score as number,
    subscore: record.subscore as number,
    ownerId: record.ownerId,
    rank: record.rank as number,
  };
}
