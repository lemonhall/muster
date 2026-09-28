/**
 * 好友列表的两条读路径：`ListFriends`（我看到的边）与 `ListFriendsOfFriends`
 * （通过好友认识的人）。
 *
 * 分页语义与上游逐条对齐（这是客户端能观察到的部分）：
 *   - 好友列表按 `(state, position)` 升序；游标指向**下一页第一行**，下一页从它开始；
 *     取到第 `limit+1` 行时用那一行做游标、并且**不返回**该行；
 *   - 好友的好友按 `(source_id, destination_id)` 升序，`limit` 是**跨好友累计**的
 *     全局上限；带游标时只查游标里那个 `source_id` 的那个好友（上游那句
 *     `if f != cursor.SourceId { continue }`），所以翻页不会因为"好友变了"而重排；
 *   - 好友的好友会**排除**自己、以及已经是我的好友的人（上游的 NOT ALL 展开）。
 *
 * `position` 的取值为本项目自造的每租户单调计数（理由见 `store.ts` 文件头），
 * 它在"越大越新"这一点上与上游的纳秒时间戳等价，且不会被游标丢精度。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_friend.go::ListFriends
 * 契约源: server/core_friend.go::ListFriendsOfFriends
 * 契约源: server/api_friend.go::ListFriends
 * 契约源: server/api_friend.go::ListFriendsOfFriends
 *
 * REQ-0001-011
 */

import { invalidArgument } from "../../http/errors";
import { assertCursorMatchesState, decodeEdgeCursor, decodeFriendsOfFriendsCursor, encodeEdgeCursor, encodeFriendsOfFriendsCursor } from "./cursor";
import { findFriendIds, findUserProfiles, listFriendRows, listFriendsOfFriendRows } from "./store";
import type { FriendRow, FriendsOfFriendsPair, UserProfileRow } from "./types";

export const DEFAULT_FRIEND_LIMIT = 1000;
export const MAX_FRIEND_LIMIT = 1000;
export const DEFAULT_FRIENDS_OF_FRIENDS_LIMIT = 10;
export const MAX_FRIENDS_OF_FRIENDS_LIMIT = 100;

export interface FriendListResult {
  readonly friends: readonly FriendRow[];
  readonly cursor: string;
}

export interface FriendsOfFriendsEntry {
  readonly referrer: string;
  readonly user: UserProfileRow;
}

export interface FriendsOfFriendsResult {
  readonly friendsOfFriends: readonly FriendsOfFriendsEntry[];
  readonly cursor: string;
}

export interface ListFriendsInput {
  readonly limit?: number | undefined;
  readonly state?: number | undefined;
  readonly cursor?: string | undefined;
}

export async function listFriends(
  db: D1Database,
  tenantId: string,
  userId: string,
  input: ListFriendsInput,
): Promise<FriendListResult> {
  const limit = input.limit ?? DEFAULT_FRIEND_LIMIT;
  if (limit < 1 || limit > MAX_FRIEND_LIMIT) {
    throw invalidArgument("Invalid limit - limit must be between 1 and 1000.");
  }
  const state = input.state;
  if (state !== undefined && (state < 0 || state > 3)) {
    throw invalidArgument("Invalid state - state must be between 0 and 3.");
  }

  const rawCursor = input.cursor ?? "";
  const cursor = rawCursor === "" ? null : decodeEdgeCursor(rawCursor);
  if (cursor !== null) assertCursorMatchesState(cursor, state);

  const rows = await listFriendRows(db, tenantId, userId, limit, state, cursor);
  const page = rows.slice(0, limit);
  const next = rows[limit];
  return {
    friends: page,
    cursor: next === undefined ? "" : encodeEdgeCursor({ state: next.state, position: next.position }),
  };
}

export interface ListFriendsOfFriendsInput {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export async function listFriendsOfFriends(
  db: D1Database,
  tenantId: string,
  userId: string,
  input: ListFriendsOfFriendsInput,
): Promise<FriendsOfFriendsResult> {
  const limit = input.limit ?? DEFAULT_FRIENDS_OF_FRIENDS_LIMIT;
  if (limit < 1 || limit > MAX_FRIENDS_OF_FRIENDS_LIMIT) {
    throw invalidArgument("Invalid limit - limit must be between 1 and 100.");
  }

  const rawCursor = input.cursor ?? "";
  const cursor = rawCursor === "" ? null : decodeFriendsOfFriendsCursor(rawCursor);

  const friendIds = await findFriendIds(db, tenantId, userId);
  if (friendIds.length === 0) return { friendsOfFriends: [], cursor: "" };

  const collected: FriendsOfFriendsPair[] = [];
  let outgoing = "";
  outer: for (const friendId of friendIds) {
    if (cursor !== null && friendId !== cursor.sourceId) continue;
    // 每次多取一行：多出来的那一行只用来做游标，不返回（上游同款做法）。
    const rows = await listFriendsOfFriendRows(
      db,
      tenantId,
      friendId,
      userId,
      friendIds,
      limit + 1,
      cursor,
    );
    for (const row of rows) {
      if (collected.length >= limit) {
        outgoing = encodeFriendsOfFriendsCursor({
          sourceId: row.referrer,
          destinationId: row.friendId,
        });
        break outer;
      }
      collected.push(row);
    }
  }

  if (collected.length === 0) return { friendsOfFriends: [], cursor: "" };

  const profiles = await findUserProfiles(
    db,
    tenantId,
    collected.map((pair) => pair.friendId),
  );
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const entries: FriendsOfFriendsEntry[] = [];
  for (const pair of collected) {
    const user = byId.get(pair.friendId);
    // 上游原话：账号可能在取列表与取资料之间被删掉了，跳过它。
    if (user === undefined) continue;
    entries.push({ referrer: pair.referrer, user });
  }
  return { friendsOfFriends: entries, cursor: outgoing };
}
