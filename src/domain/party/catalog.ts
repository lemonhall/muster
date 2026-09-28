/**
 * 派对目录：`GET /v2/party` 背后的筛选、排序与游标。
 *
 * 上游把目录放在 bluge 内存索引里（`LocalPartyRegistry` 的 `pendingUpdates` +
 * `indexWriter`），本项目换成 D1 表（`party_record`，见 ECN-0013 偏差 2）。
 * **筛选语义是一致的**：
 *
 * - `query` 走的是与匹配器同一套查询语法（`ParseQueryString`），标签按
 *   `label.<key>` 摊平成可查询字段。空串被规整成 `*`（匹配全部）；
 * - `open` 可给可不给：`true` 只列开放派对、`false` 只列私有派对、不给则不限；
 * - `showHidden = false` 恒定（上游 `ListParties` 就是这么调的），隐藏派对不进目录；
 * - 游标里带着 `query` / `limit` / `open` 三项，任何一项与本次请求不一致就报
 *   `invalid cursor: param <x> mismatch`——上游原话，用来挡住"拿旧游标配新过滤条件"。
 *
 * 与上游的一处**刻意差异**：排序。上游 bluge 的 `TopNSearch` 默认按相关度排序，
 * 而 `query` 为空时全部命中同一分数，同分文档的顺序由索引内部结构决定（不可复现）。
 * 本项目固定成 `create_time DESC, party_id ASC`——与 `GET /v2/match` 的处置同一条
 * 理由（ECN-0011 偏差 8）：**没有断言依赖上游那个未定义的顺序**，而可复现的顺序
 * 才让"翻页不漏不重"可以被测。记在 ECN-0013 偏差 2。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::LocalPartyRegistry.PartyList
 * 契约源: server/party_registry.go::LocalPartyRegistry.LabelUpdate
 *
 * REQ-0001-019
 */

import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../base64url";
import { matchFields, parseMatchmakerQuery, propertyFields, type PropertyValue } from "../matchmaker/query";
import type { PartyListFilters, PartyListPage, PartyRecord } from "./types";

/** 一次列表最多扫多少行。与对局列表同一个理由（`LISTING_SCAN_CAP`）。 */
export const PARTY_LISTING_SCAN_CAP = 10_000;

/** 标签 → 可查询字段。不是合法 JSON 对象时没有字段（查询串没有可命中的东西）。 */
export function partyLabelFields(label: string): ReadonlyMap<string, readonly (string | number | boolean)[]> {
  try {
    const parsed: unknown = JSON.parse(label);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const properties: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        Array.isArray(value)
      ) {
        properties[key] = value as PropertyValue;
      }
    }
    return propertyFields(properties, "label.");
  } catch {
    return new Map();
  }
}

/**
 * 过滤 + 排序 + 分页。`filters.offset` 是游标里的偏移量，`undefined` = 第一页。
 *
 * 隐藏派对在这里**不再判**：它由数据源（`WHERE hidden = 0`）挡掉，于是"目录里看不到
 * 隐藏派对"是一句 SQL 就能验的事实，而不是一条容易漏掉的领域判断。
 */
export function listParties(
  records: readonly PartyRecord[],
  filters: PartyListFilters,
): PartyListPage {
  if (filters.limit === 0) return { parties: [], cursor: "" };

  const query = filters.query === undefined || filters.query === "" ? null : parseMatchmakerQuery(filters.query);
  const scored: PartyRecord[] = [];
  for (const record of records) {
    if (filters.open !== undefined && record.open !== filters.open) continue;
    if (query !== null && !matchFields(query, partyLabelFields(record.label)).matched) continue;
    scored.push(record);
  }

  scored.sort((left, right) => {
    if (left.createTime !== right.createTime) return right.createTime - left.createTime;
    return left.partyId < right.partyId ? -1 : left.partyId > right.partyId ? 1 : 0;
  });

  const offset = filters.offset ?? 0;
  const page = scored.slice(offset, offset + filters.limit);
  const hasMore = scored.length > offset + filters.limit;
  const cursor = hasMore
    ? encodePartyCursor({
        // 游标里存**规整后**的查询串（空串 → `*`），与上游一致：上游在进索引前就
        // 归一了，游标里带着的是归一后的值，于是"没给 query"与"给了空 query"
        // 翻页时不会互相当成不匹配。
        query: filters.query === undefined || filters.query === "" ? "*" : filters.query,
        open: filters.open,
        offset: offset + filters.limit,
        limit: filters.limit,
      })
    : "";
  return { parties: page, cursor };
}

export interface PartyCursor {
  readonly query: string;
  readonly open: boolean | undefined;
  readonly offset: number;
  readonly limit: number;
}

/** `open` 的三态（不给 / false / true）在 JSON 里要能分开，所以用 `0 | 1 | 2`。 */
function openCode(open: boolean | undefined): number {
  if (open === undefined) return 0;
  return open ? 2 : 1;
}

function codeOpen(code: unknown): boolean | undefined | null {
  if (code === 0) return undefined;
  if (code === 1) return false;
  if (code === 2) return true;
  return null;
}

export function encodePartyCursor(cursor: PartyCursor): string {
  return toBase64Url(
    JSON.stringify({ q: cursor.query, o: openCode(cursor.open), f: cursor.offset, l: cursor.limit }),
  );
}

/**
 * 解游标。坏游标、字段类型不对、或者三项与本次请求不一致，都抛 `Error`——
 * 上游对这些情况一律在 API 层变成 `Internal` + `Error listing matches.`，
 * 所以这里不区分文案，由路由层统一映射（文案在 `src/http/routes/party.ts`）。
 */
export function decodePartyCursor(raw: string, current: { query: string; open: boolean | undefined; limit: number }): PartyCursor {
  if (raw.length > MAX_CURSOR_LENGTH) throw new Error("invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw new Error("invalid cursor");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid cursor");
  }
  const record = parsed as Record<string, unknown>;
  const query = record["q"];
  const open = codeOpen(record["o"]);
  const offset = record["f"];
  const limit = record["l"];
  if (typeof query !== "string") throw new Error("invalid cursor");
  if (open === null) throw new Error("invalid cursor");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("invalid cursor");
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw new Error("invalid cursor");

  // 上游三条一致性校验：查询串 → 上限 → 开放位。文案逐字对齐。
  if (query !== current.query) throw new Error("invalid cursor: param query mismatch");
  if (limit !== current.limit) throw new Error("invalid cursor: param limit mismatch");
  if (open !== current.open) throw new Error("invalid cursor: param open mismatch");
  return { query, open, offset, limit };
}
