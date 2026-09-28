/**
 * 群组目录（`ListGroups`）的九条排序分支。
 *
 * 上游是一大段 `switch { case ... }` 拼 SQL，这里照抄它的分支顺序与判定条件——因为
 * "同时给了多个过滤条件时谁先命中"本身就是对外行为（例如 `open=false` + `langTag`
 * 命中第二条而不是第九条）。
 *
 * 三处与上游**有意不同**的地方（登记在 ECN-0008）：
 *
 * 1. 上游每条分支的 `WHERE disable_time = '1970-01-01 00:00:00 UTC'` 是"暂时停用"
 *    功能的占位（项目里没有 `disable_time` 列），本项目省略它；
 * 2. 上游用 `ILIKE`，本项目用 SQLite 的 `LIKE`（ASCII 大小写不敏感，中文等非 ASCII
 *    本来就没有大小写概念）；
 * 3. 上游 `open + langTag`（不带 `members`）那条分支的游标比较**写错了**：
 *    `ORDER BY` 是 DESC，比较符却是 `>`，且比较的字段顺序（state, lang_tag,
 *    edge_count, id）与排序字段顺序（state, edge_count, lang_tag, id）不一致。
 *    那会让翻页重复上一页的行。本项目把比较符改成 `<`（与 DESC 同向）并让比较的
 *    字段顺序与 `ORDER BY` 一致。
 *
 * 一处本项目**必须**多出来的条件：`g.tenant_id = ?`。上游一个部署只有一个数据库，
 * 而本项目一个数据库住着多个租户（ECN-0001），少了它群目录就会跨租户串数据。
 *
 * 游标一律指向**下一页第一行（含）**：读 `limit + 1` 行，多出来的那一行用来生成游标，
 * 所以最后一行等于它时不会被跳过，这是上游 `edgeListCursor` 与 `groupConvertRows`
 * 共同的语义。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::ListGroups
 * 契约源: server/core_group.go::groupConvertRows
 *
 * REQ-0001-012
 */

import { GROUP_COLUMNS } from "./store";
import type { GroupListCursor } from "./types";

/**
 * `groups.state` 的表达式形式：库里是布尔 `open`，比较与排序都用上游的 0/1 语义。
 *
 * 写成表达式而不是"先读出来再在 JS 里排"，是因为排序发生在 SQL 里——把它折回
 * 上游语义这一步必须也在 SQL 里，否则"开放优先还是私有优先"就会反过来。
 */
const STATE_EXPR = "CASE WHEN g.open = 1 THEN 0 ELSE 1 END";

export interface GroupListFilters {
  /** 租户：群目录是**每个租户各自一片**的目录，这一条不能少（ECN-0001）。 */
  readonly tenantId: string;
  /** 已 `TrimLeft("% ")` 过的名字前缀；空串表示不按名字过滤。 */
  readonly name: string;
  readonly langTag: string;
  readonly open: boolean | undefined;
  /** `-1` 表示不按人数过滤（上游的哨兵值）。 */
  readonly edgeCount: number;
  readonly limit: number;
  readonly cursor: GroupListCursor | null;
}

export interface GroupListQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** 一个分支的全部输入：过滤条件、排序键、游标比较的方向与取值。 */
interface Branch {
  readonly where: readonly string[];
  readonly order: string;
  /** 与 `ORDER BY` **同序**的表达式列表，用于行值比较。 */
  readonly keys: readonly string[];
  readonly direction: "<" | ">";
  /** 与 `keys` 一一对应的游标取值。 */
  readonly values: readonly unknown[];
}

function stateOf(open: boolean): number {
  return open ? 0 : 1;
}

/**
 * `open` 过滤条件的**列值**：库里那一列是布尔（1 = 开放），而上游的 `state` 是
 * 0 = 开放。两者正好相反，所以过滤条件必须用 `open ? 1 : 0`——直接用 `stateOf()`
 * 会让"只要开放群"查出私有群（排序那个表达式是 `CASE WHEN`，不受影响，但过滤不是）。
 */
function openColumn(state: number): number {
  return state === 0 ? 1 : 0;
}

export function buildGroupListQuery(filters: GroupListFilters): GroupListQuery {
  const params: unknown[] = [];
  const placeholder = (value: unknown): string => `?${params.push(value)}`;

  const { tenantId, name, langTag, open, edgeCount, cursor } = filters;
  const where: string[] = [`g.tenant_id = ${placeholder(tenantId)}`];
  let order: string;
  let keys: readonly string[];
  let direction: "<" | ">";
  let values: readonly unknown[];

  const state = open === undefined ? undefined : stateOf(open);

  if (name !== "") {
    // 只按名字（名字与其它过滤条件互斥，守卫在 `listing.ts` 里）。
    where.push(`g.name LIKE ${placeholder(name)}`);
    order = "g.name ASC";
    keys = ["g.name"];
    direction = ">";
    values = [cursor?.name ?? ""];
  } else if (state !== undefined && langTag !== "" && edgeCount > -1) {
    where.push(
      `g.open = ${placeholder(openColumn(state))}`,
      `g.lang_tag = ${placeholder(langTag)}`,
      `g.edge_count <= ${placeholder(edgeCount)}`,
    );
    order = `${STATE_EXPR} DESC, g.lang_tag DESC, g.edge_count DESC, g.id DESC`;
    keys = [STATE_EXPR, "g.lang_tag", "g.edge_count", "g.id"];
    direction = "<";
    values = [stateOf(open === true), cursor?.langTag ?? "", cursor?.edgeCount ?? 0, cursor?.id ?? ""];
  } else if (state !== undefined && langTag !== "") {
    where.push(`g.open = ${placeholder(openColumn(state))}`, `g.lang_tag = ${placeholder(langTag)}`);
    order = `${STATE_EXPR} DESC, g.edge_count DESC, g.lang_tag DESC, g.id DESC`;
    keys = [STATE_EXPR, "g.edge_count", "g.lang_tag", "g.id"];
    direction = "<";
    values = [stateOf(open === true), cursor?.edgeCount ?? 0, cursor?.langTag ?? "", cursor?.id ?? ""];
  } else if (state !== undefined && edgeCount > -1) {
    where.push(`g.open = ${placeholder(openColumn(state))}`, `g.edge_count <= ${placeholder(edgeCount)}`);
    order = `${STATE_EXPR} DESC, g.edge_count DESC, g.lang_tag DESC, g.id DESC`;
    keys = [STATE_EXPR, "g.edge_count", "g.lang_tag", "g.id"];
    direction = "<";
    values = [stateOf(open === true), cursor?.edgeCount ?? 0, cursor?.langTag ?? "", cursor?.id ?? ""];
  } else if (langTag !== "" && edgeCount > -1) {
    where.push(`g.lang_tag = ${placeholder(langTag)}`, `g.edge_count <= ${placeholder(edgeCount)}`);
    order = "g.lang_tag DESC, g.edge_count DESC, g.id DESC";
    keys = ["g.lang_tag", "g.edge_count", "g.id"];
    direction = "<";
    values = [cursor?.langTag ?? "", cursor?.edgeCount ?? 0, cursor?.id ?? ""];
  } else if (langTag !== "") {
    where.push(`g.lang_tag = ${placeholder(langTag)}`);
    order = "g.lang_tag ASC, g.edge_count ASC, g.id ASC";
    keys = ["g.lang_tag", "g.edge_count", "g.id"];
    direction = ">";
    values = [cursor?.langTag ?? "", cursor?.edgeCount ?? 0, cursor?.id ?? ""];
  } else if (edgeCount > -1) {
    where.push(`g.edge_count <= ${placeholder(edgeCount)}`);
    order = "g.edge_count DESC, g.update_time DESC, g.id DESC";
    keys = ["g.edge_count", "g.update_time", "g.id"];
    direction = "<";
    values = [cursor?.edgeCount ?? 0, cursor?.updateTime ?? 0, cursor?.id ?? ""];
  } else if (state !== undefined) {
    where.push(`g.open = ${placeholder(openColumn(state))}`);
    order = "g.update_time ASC, g.edge_count ASC, g.id ASC";
    keys = ["g.update_time", "g.edge_count", "g.id"];
    direction = ">";
    values = [cursor?.updateTime ?? 0, cursor?.edgeCount ?? 0, cursor?.id ?? ""];
  } else {
    order = "g.update_time ASC, g.edge_count ASC, g.id ASC";
    keys = ["g.update_time", "g.edge_count", "g.id"];
    direction = ">";
    values = [cursor?.updateTime ?? 0, cursor?.edgeCount ?? 0, cursor?.id ?? ""];
  }

  if (cursor !== null) {
    const tuple = values.map((value) => placeholder(value)).join(", ");
    where.push(`(${keys.join(", ")}) ${direction} (${tuple})`);
  }

  const whereClause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  const sql = `SELECT ${GROUP_COLUMNS} FROM groups g${whereClause} ORDER BY ${order} LIMIT ${placeholder(filters.limit + 1)}`;
  return { sql, params };
}
