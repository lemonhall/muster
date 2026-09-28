/**
 * 排行榜 / 锦标赛写分请求体的解析（两套端点共用同一份 `LeaderboardRecordWrite` 形状）。
 *
 * protojson 的三条解码规则在这里落地：
 *   - **int64 收两种写法**：JSON 数字与十进制字符串都认（`"10"` 与 `10` 同义），
 *     但 `10.5` 与 `"abc"` 都是 400；
 *   - **枚举收两种写法**：`"BEST"` 与 `1` 同义（见 `wire/competitive.ts`）；
 *   - 字段名同时接受 proto 原名（`subscore`）与 JSON 名（两者恰好相同）。
 *
 * `metadata` 的校验与上游逐字一致：给了就必须是**合法的 JSON 对象**，
 * 空串表示"不动 metadata"（不是"清空"）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_leaderboard.go::WriteLeaderboardRecord
 * 契约源: server/api_tournament.go::WriteTournamentRecord
 */

import { asObject, optionalString, parseBody, readField } from "../body";
import { invalidArgument } from "../errors";
import type { UserContext } from "../router";
import type { LeaderboardRecordWriteInput } from "../../domain/competitive/leaderboard/write";
import { parseOperatorOverride } from "../../wire/competitive";

const MISSING_RECORD = "Invalid input, record score value is required.";
const INVALID_METADATA = "Metadata value must be JSON, if provided.";

/** protojson 的 int64：数字或十进制字符串，其余一律 400。 */
export function parseInt64(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  throw invalidArgument(`invalid value for int64 field ${field}`);
}

/** 空串放行；其余必须是合法 JSON 且顶层是对象（上游只检查首字节是 `{`，两者等价）。 */
export function parseMetadata(value: string): string {
  if (value === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidArgument(INVALID_METADATA);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgument(INVALID_METADATA);
  }
  return value;
}

/**
 * 写分请求 → 领域入参。
 *
 * `ownerId` 恒等于调用者：上游 REST 面只允许"写自己的分"（权威写只有 server key
 * 那条路径，本项目尚未开放，见 ECN-0010 偏差 10）。
 */
export async function recordInput(
  context: UserContext,
  leaderboardId: string,
  invalidIdMessage: string,
): Promise<LeaderboardRecordWriteInput> {
  if (leaderboardId === "") throw invalidArgument(invalidIdMessage);
  const body = await parseBody(context.request);
  const container = asObject(body, "body");
  const rawRecord = readField(container, "record");
  if (rawRecord === undefined || rawRecord === null) throw invalidArgument(MISSING_RECORD);
  const record = asObject(rawRecord, "record");
  const metadata = parseMetadata(optionalString(record, "metadata") ?? "");
  return {
    callerId: context.session.user.id,
    ownerId: context.session.user.id,
    username: context.session.user.username,
    score: parseInt64(readField(record, "score"), "score"),
    subscore: parseInt64(readField(record, "subscore"), "subscore"),
    metadata,
    overrideOperator: parseOperatorOverride(readField(record, "operator")),
  };
}
