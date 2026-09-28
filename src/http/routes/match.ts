/**
 * 对局与匹配器的两条 REST 端点：
 *
 *   GET /v2/match              列出正在跑的对局（可按标签、查询串、人数筛）
 *   GET /v2/matchmaker/stats   匹配器统计（票数、最老票的创建时间、最近成局样本）
 *
 * 校验顺序照抄上游 `ApiServer.ListMatches`——顺序错了文案就会错：
 *   limit 范围 → label 与非权威冲突 → query 与非权威冲突 → min_size → max_size →
 *   min_size vs max_size；之后才轮到"列不出来 → `Error listing matches.`"。
 *
 * 两条**只有这里才知道**的语义（上游用"指针是不是 nil"表达"给没给这个参数"）：
 *   - `?label=`（空串）与"没给 label"是**两回事**：前者会让列表只看权威对局；
 *   - `?authoritative=false` 与 `?authoritative=` 也不同：后者算给了 `false`，
 *     会直接 400（`queryBool` 那种"空 = 缺省"的写法在这里会写错）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_match.go::ApiServer.ListMatches
 * 契约源: server/api_matchmaker.go::ApiServer.GetMatchmakerStats
 *
 * REQ-0001-018
 */

import { json, queryOptionalBool, queryOptionalInt } from "../body";
import { invalidArgument, internal } from "../errors";
import type { Router, UserContext } from "../router";
import { listMatchRecords } from "../../domain/match/store";
import { matchmakerStats } from "../../durable/matchmaker-call";
import { matchListBody, matchmakerStatsBody } from "../../wire/match";

const INVALID_LIMIT = "Invalid limit - limit must be between 1 and 100.";
const LABEL_NOT_AUTHORITATIVE = "Label filtering is not supported for non-authoritative matches.";
const QUERY_NOT_AUTHORITATIVE = "Query filtering is not supported for non-authoritative matches.";
const MIN_SIZE_NEGATIVE = "Minimum size must be 0 or above.";
const MAX_SIZE_NEGATIVE = "Maximum size must be 0 or above.";
const SIZE_RANGE_BROKEN = "Maximum size must be greater than or equal to minimum size when both are specified.";
const LIST_FAILED = "Error listing matches.";

/**
 * 取一个"给没给"分明的 query 参数。
 *
 * grpc-gateway 对同一个字段接受两种写法（proto 名 `min_size` 与 JSON 名 `minSize`），
 * 上游 swagger 声明的是后者，客户端两种都在用。没给 → `undefined`；
 * 给了但值是空串 → `""`（**不是** undefined，`?label=` 靠这个区别活着）。
 */
function givenValue(url: URL, camel: string, snake: string): string | undefined {
  for (const name of [camel, snake]) {
    const value = url.searchParams.get(name);
    if (value !== null) return value;
  }
  return undefined;
}

function givenInt(url: URL, camel: string, snake: string, message: string): number | undefined {
  for (const name of [camel, snake]) {
    if (url.searchParams.has(name)) return queryOptionalInt(url, name, message);
  }
  return undefined;
}

export function registerMatchRoutes(router: Router): void {
  router.handleUser("GET", "/v2/match", async (context) => {
    const { url } = context;

    let limit = 10;
    const rawLimit = givenInt(url, "limit", "limit", INVALID_LIMIT);
    if (rawLimit !== undefined) {
      if (rawLimit < 1 || rawLimit > 100) throw invalidArgument(INVALID_LIMIT);
      limit = rawLimit;
    }

    const authoritative = queryOptionalBool(url, "authoritative");
    const label = givenValue(url, "label", "label");
    const query = givenValue(url, "query", "query");
    if (label !== undefined && authoritative === false) throw invalidArgument(LABEL_NOT_AUTHORITATIVE);
    if (query !== undefined && authoritative === false) throw invalidArgument(QUERY_NOT_AUTHORITATIVE);

    const minSize = givenInt(url, "minSize", "min_size", MIN_SIZE_NEGATIVE);
    if (minSize !== undefined && minSize < 0) throw invalidArgument(MIN_SIZE_NEGATIVE);
    const maxSize = givenInt(url, "maxSize", "max_size", MAX_SIZE_NEGATIVE);
    if (maxSize !== undefined && maxSize < 0) throw invalidArgument(MAX_SIZE_NEGATIVE);
    if (minSize !== undefined && maxSize !== undefined && minSize > maxSize) {
      throw invalidArgument(SIZE_RANGE_BROKEN);
    }

    const records = await listMatchRecords(context.env.DB, context.tenantEnv.tenantId, {
      limit,
      authoritative,
      label,
      minSize,
      maxSize,
      query,
    }).catch((error: unknown) => {
      console.error("列出对局失败", error);
      throw internal(LIST_FAILED);
    });
    return json(matchListBody(records));
  });

  router.handleUser("GET", "/v2/matchmaker/stats", async (context: UserContext) => {
    const stats = await matchmakerStats(context.env, context.tenantEnv.tenantId);
    return json(matchmakerStatsBody(stats));
  });
}
