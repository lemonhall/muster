/**
 * 好友的 REST 端点（5 条）：
 *
 *   GET    /v2/friend            列出"我看到的边"（含状态过滤与分页）
 *   POST   /v2/friend            发好友请求 / 接受对方的请求
 *   DELETE /v2/friend            解除关系（或解除单方面拉黑）
 *   POST   /v2/friend/block      拉黑
 *   GET    /v2/friend/friends    好友的好友（推荐）
 *
 * 一个容易看漏的事：上游这五条的 `ids` / `usernames` / `metadata` **都在 query 里**，
 * 不是 JSON body。swagger 里它们的 `in` 全是 `query`（grpc-gateway 对没有 `body`
 * 绑定的方法就是这么取值的），所以这里用 `queryList`/`queryValue` 读，不去解 body。
 *
 * 校验顺序照抄上游 `ApiServer.*`：先 limit、再 state、再逐条 id/username；
 * "一条都没剩下"在加/拉黑时报错、在删好友时是成功的空操作。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/friend
 * 契约源: server/api_friend.go::ListFriends
 * 契约源: server/api_friend.go::AddFriends
 * 契约源: server/api_friend.go::DeleteFriends
 * 契约源: server/api_friend.go::BlockFriends
 * 契约源: server/api_friend.go::ListFriendsOfFriends
 *
 * REQ-0001-011
 */

import { json, queryList, queryValue } from "../body";
import { invalidArgument } from "../errors";
import type { Router } from "../router";
import type { UserContext } from "../router";
import { registryOnline } from "../../durable/registry-call";
import { addFriends, blockFriends, deleteFriends, type FriendCaller } from "../../domain/friends/mutate";
import { listFriends, listFriendsOfFriends } from "../../domain/friends/service";
import { resolveFriendTargets } from "../../domain/friends/validate";
import { friendListBody, friendsOfFriendsBody } from "../../wire/friend";

const INVALID_FRIEND_LIMIT = "Invalid limit - limit must be between 1 and 1000.";
const INVALID_FOF_LIMIT = "Invalid limit - limit must be between 1 and 100.";
const NO_VALID_TARGET = "No valid ID or username was provided.";

export const SELF_ADD = "Cannot add self as friend.";
export const SELF_DELETE = "Cannot delete self.";
export const SELF_BLOCK = "Cannot block self.";

/**
 * query 里的 Int32Value：没给 → `undefined`（"不是 0，是没这个字段"），
 * 给了但不是整数 → 按该端点自己的 limit 文案报错（与本项目存储端点的既有做法一致）。
 */
function queryInt(url: URL, name: string, invalidMessage: string): number | undefined {
  const raw = queryValue(url, name);
  if (raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw invalidArgument(invalidMessage);
  return parsed;
}

function callerOf(context: UserContext): FriendCaller {
  return { id: context.session.user.id, username: context.session.user.username };
}

/** 加/拉黑的共同前半段：读 query → 解析出确定存在的目标；空集是错误。 */
async function requireTargets(context: UserContext, selfMessage: string): Promise<string[]> {
  const ids = queryList(context.url, "ids");
  const usernames = queryList(context.url, "usernames");
  if (ids.length === 0 && usernames.length === 0) return [];
  const caller = callerOf(context);
  const targets = await resolveFriendTargets(context.env.DB, context.tenantEnv.tenantId, {
    ids,
    usernames,
    selfId: caller.id,
    selfUsername: caller.username,
    selfMessage,
  });
  if (targets.length === 0) throw invalidArgument(NO_VALID_TARGET);
  return targets;
}

export function registerFriendRoutes(router: Router): void {
  router.handleUser("GET", "/v2/friend", async (context) => {
    const limit = queryInt(context.url, "limit", INVALID_FRIEND_LIMIT);
    const state = queryInt(context.url, "state", "Invalid state - state must be between 0 and 3.");
    const tenantId = context.tenantEnv.tenantId;
    const result = await listFriends(context.env.DB, tenantId, context.session.user.id, {
      ...(limit === undefined ? {} : { limit }),
      ...(state === undefined ? {} : { state }),
      cursor: queryValue(context.url, "cursor"),
    });
    const online = await registryOnline(
      context.env,
      tenantId,
      result.friends.map((row) => row.id),
    );
    return json(friendListBody(result, online));
  });

  router.handleUser("GET", "/v2/friend/friends", async (context) => {
    const limit = queryInt(context.url, "limit", INVALID_FOF_LIMIT);
    const tenantId = context.tenantEnv.tenantId;
    const result = await listFriendsOfFriends(context.env.DB, tenantId, context.session.user.id, {
      ...(limit === undefined ? {} : { limit }),
      cursor: queryValue(context.url, "cursor"),
    });
    const online = await registryOnline(
      context.env,
      tenantId,
      result.friendsOfFriends.map((entry) => entry.user.id),
    );
    return json(friendsOfFriendsBody(result, online));
  });

  router.handleUser("POST", "/v2/friend", async (context) => {
    const targets = await requireTargets(context, SELF_ADD);
    // 上游：空入参直接成功（`len(ids)==0 && len(usernames)==0` 的早退）。
    if (targets.length === 0) return json({});
    await addFriends(
      context.env,
      context.tenantEnv.tenantId,
      callerOf(context),
      targets,
      queryValue(context.url, "metadata"),
      context.tenantEnv.nowSec,
    );
    return json({});
  });

  router.handleUser("DELETE", "/v2/friend", async (context) => {
    const ids = queryList(context.url, "ids");
    const usernames = queryList(context.url, "usernames");
    if (ids.length === 0 && usernames.length === 0) return json({});
    const caller = callerOf(context);
    const targets = await resolveFriendTargets(context.env.DB, context.tenantEnv.tenantId, {
      ids,
      usernames,
      selfId: caller.id,
      selfUsername: caller.username,
      selfMessage: SELF_DELETE,
    });
    // 删好友时"一条都没剩下"是成功的空操作（上游这里是 info 日志 + 空响应，不是错误）。
    if (targets.length === 0) return json({});
    await deleteFriends(context.env, context.tenantEnv.tenantId, caller, targets, context.tenantEnv.nowSec);
    return json({});
  });

  router.handleUser("POST", "/v2/friend/block", async (context) => {
    const targets = await requireTargets(context, SELF_BLOCK);
    if (targets.length === 0) return json({});
    await blockFriends(
      context.env,
      context.tenantEnv.tenantId,
      callerOf(context),
      targets,
      context.tenantEnv.nowSec,
    );
    return json({});
  });
}
