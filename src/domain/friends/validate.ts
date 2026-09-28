/**
 * 好友端点的入参校验：把"给我一组 id / username"翻译成"一组确定存在的用户 id"。
 *
 * 校验顺序与错误文案逐条照抄上游 `ApiServer.AddFriends` / `DeleteFriends` /
 * `BlockFriends`（三者的差别只有"把自己写进去"那一句的动词），因为这些字符串是
 * 客户端分支判断的依据：
 *
 *   1. ids 先于 usernames 校验；
 *   2. 每条 id 先查"是不是自己"，再查"像不像一个 id"——顺序反过来的话，
 *      把自己写错格式会得到"Invalid user ID"而不是"Cannot add self as friend."；
 *   3. username 为空 → `Username must not be empty.`，与自己同名 → 同一句 self 文案；
 *   4. 查不到的 username 是**静默忽略**（上游 `fetchUserID` 只回查到的行）；
 *   5. "一个都没剩下"由调用方决定：加/拉黑报错，删好友是成功的空操作。
 *
 * 一处刻意的实现差异：上游拿 `userID.String() == id` 比大小写敏感的字符串，
 * 本项目 `users.id` 存大写标准形，所以这里比的是**规范化之后**的值。对"客户端原样
 * 回传服务端给的 id"这一常见路径，两者行为一致；差异只出现在调用方自己改写了
 * 自己 id 的大小写或写法时——那时本项目更严格地认出"这是你自己"。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_friend.go::AddFriends
 * 契约源: server/api_friend.go::DeleteFriends
 * 契约源: server/api_friend.go::BlockFriends
 * 契约源: server/core_user.go::fetchUserID
 *
 * REQ-0001-011
 */

import { invalidArgument } from "../../http/errors";
import { findUsersByUsernames } from "../identity/store";
import { normalizeUserId } from "../../realtime/identifiers";

const NIL_ID = "00000000-0000-0000-0000-000000000000";

export interface FriendTargetInput {
  readonly ids: readonly string[];
  readonly usernames: readonly string[];
  readonly selfId: string;
  readonly selfUsername: string;
  /** 上游那一句的动词：`Cannot <verb> self.` / `Cannot <verb> self as friend.` */
  readonly selfMessage: string;
}

/**
 * 解析成"确定存在的用户 id 列表"（去重由调用方按需处理）。
 *
 * 返回空数组表示"调用方给的 id 与 username 都没能对上任何账号"，语义由调用方决定。
 */
export async function resolveFriendTargets(
  db: D1Database,
  tenantId: string,
  input: FriendTargetInput,
): Promise<string[]> {
  const resolved: string[] = [];

  for (const raw of input.ids) {
    const normalized = normalizeUserId(raw);
    if (normalized === input.selfId) throw invalidArgument(input.selfMessage);
    if (normalized === null || normalized === NIL_ID) {
      throw invalidArgument(`Invalid user ID '${raw}'.`);
    }
    resolved.push(normalized);
  }

  for (const username of input.usernames) {
    if (username === "") throw invalidArgument("Username must not be empty.");
    if (username === input.selfUsername) throw invalidArgument(input.selfMessage);
  }

  const found = await findUsersByUsernames(db, tenantId, input.usernames);
  for (const row of found) resolved.push(row.id);

  return resolved;
}
