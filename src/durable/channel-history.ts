/**
 * 频道历史的分页算法：`ChannelMessagesList` 里与 SQL 无关的那一半。
 *
 * 上游这一段有**两根互相独立的轴**，混起来就会翻出重复页或跳帧，所以这里照着源码
 * 逐行搬（`server/core_channel.go` 的 `ChannelMessagesList`）：
 *
 * - `forward`：用户视角的顺序（true = 从旧到新）。它同时决定"下一页往哪走"；
 * - `cursor.isNext`：这条游标是"下一页的开始"还是"上一页的开始"。两者相同时向前扫，
 *   不同时向后扫（`(forward && IsNext) || (!forward && !IsNext)`）。
 *
 * 三条与上游一致的可观测行为：
 * 1. 多扫一行（`limit + 1`）**只用来判断还有没有下一页**；`next_cursor` 取自
 *    **最后返回的那一条**——因为下游查询用的是严格 `>`，游标指向"这一页的最后一条"，
 *    下一页才从它的下一条开始。这一点很容易读错上游源码：Go 那边 `nextCursor` 是在
 *    `rows.Scan` **之前**取的，那时 `dbID` 还是上一轮（= 最后一条被返回的）的值；
 *    如果按"第 limit+1 行"写游标，那一条会被下一页跳过；
 * 2. 请求里带了游标时，才可能产出 `prev_cursor`（"只有分页列表才有上一页"）；
 * 3. 回翻（`isNext=false`）时结果会被**翻转成正序**，并把两个游标的角色互换。
 *    `cacheable_cursor` 始终取自"返回的最后一条"，用于客户端做增量缓存。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::ChannelMessagesList
 *
 * REQ-0001-010
 */

import {
  encodeChannelCursor,
  type ChannelMessageCursor,
} from "../realtime/channel-cursor";
import type { ChannelStream } from "../realtime/channel-ids";
import type { ChannelMessages, MessageRow } from "./channel-messages";

export interface ChannelHistoryRequest {
  /** 已校验过"属于这个频道、方向一致"的游标；没给就是从头开始。 */
  readonly cursor: ChannelMessageCursor | undefined;
  readonly limit: number;
  readonly forward: boolean;
}

export interface ChannelHistoryPage {
  readonly rows: readonly MessageRow[];
  readonly nextCursor: string;
  readonly prevCursor: string;
  readonly cacheableCursor: string;
}

function cursorWith(
  stream: ChannelStream,
  row: MessageRow,
  forward: boolean,
  isNext: boolean,
): ChannelMessageCursor {
  return {
    mode: stream.mode,
    subject: stream.subject,
    subcontext: stream.subcontext,
    label: stream.label,
    createTimeMs: row.create_time_ms,
    id: row.id,
    forward,
    isNext,
  };
}

export function readChannelHistory(
  messages: ChannelMessages,
  stream: ChannelStream,
  request: ChannelHistoryRequest,
): ChannelHistoryPage {
  const { cursor, limit, forward } = request;
  // 扫描方向：没有游标时就是用户方向；有游标时看游标那根轴（推导见文件头注释）。
  const ascending = cursor === undefined ? forward : forward === cursor.isNext;
  const anchor =
    cursor === undefined ? undefined : { createTimeMs: cursor.createTimeMs, id: cursor.id };

  const scanned = messages.scan(ascending, limit + 1, anchor);
  const rows: MessageRow[] = [];
  let next: ChannelMessageCursor | undefined;
  let prev: ChannelMessageCursor | undefined;

  for (const row of scanned) {
    // 第 limit+1 行只用来当"还有下一页"的证据（游标见下）。
    if (rows.length >= limit) break;
    rows.push(row);
    if (cursor !== undefined && prev === undefined) {
      prev = cursorWith(stream, row, forward, false);
    }
  }

  const last = rows[rows.length - 1];
  // 多扫到一行 = 还有下一页；游标落在**这一页的最后一条**上（下一页从它的下一条开始）。
  if (scanned.length > limit && last !== undefined) {
    next = cursorWith(stream, last, forward, true);
  }

  if (cursor !== undefined && !cursor.isNext) {
    // 回翻：两个游标的角色互换，方向各翻一次，结果翻转成正序。
    const previousNext = next;
    next = prev;
    prev = previousNext;
    if (next !== undefined) next = { ...next, isNext: !next.isNext };
    if (prev !== undefined) prev = { ...prev, isNext: !prev.isNext };
    rows.reverse();
  }

  let cacheable: ChannelMessageCursor | undefined;
  // 翻转之后"最后一条"才是**最新**的那条（正序扫描时本来就是）。
  const newest = rows[rows.length - 1];
  if (newest !== undefined) {
    cacheable = cursorWith(stream, newest, true, true);
  } else if (cursor !== undefined) {
    // 一条都没返回：正向回翻时原样复用，倒序回翻时改成"正向的下一页"（上游这么写的）。
    cacheable = forward ? cursor : { ...cursor, forward: true, isNext: true };
  }

  return {
    rows,
    nextCursor: next === undefined ? "" : encodeChannelCursor(next),
    prevCursor: prev === undefined ? "" : encodeChannelCursor(prev),
    cacheableCursor: cacheable === undefined ? "" : encodeChannelCursor(cacheable),
  };
}
