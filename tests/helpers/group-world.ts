import { env } from "cloudflare:test";

import { bearer, call } from "./tenants";
import { socialWorld, type SocialAccount, type SocialWorld } from "./social-world";

/**
 * M5 群组套件的工装：在 `socialWorld` 之上补三件事。
 *
 * 1. **读库**：断言必须看 `groups` / `group_edge` 里的真行，而不是只看 HTTP 响应体——
 *    群组域最容易出的错就是"响应看着对，边写歪了"（例如封禁那条单行边写成了双行）；
 * 2. **HTTP 走一遍**：建群、加入、成员列表这些都有官方形状，用真实端点而不是直接写库，
 *    否则测的是"工装能不能造数据"，不是"端点对不对"；
 * 3. **足够多的账号**：群组的权限矩阵需要 superadmin / admin / member / 局外人四种身份。
 *
 * 每个用例一个随机租户（沿用 `socialWorld` 的做法），所以清理是不必要的。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export interface GroupDbRow {
  readonly id: string;
  readonly creator_id: string;
  readonly name: string;
  readonly description: string;
  readonly avatar_url: string;
  readonly lang_tag: string;
  readonly metadata: string;
  /** 1 开放 / 0 私有（库里是布尔，不是上游的 `state`）。 */
  readonly open: number;
  readonly edge_count: number;
  readonly max_count: number;
  readonly create_time: number;
  readonly update_time: number;
}

export interface GroupEdgeRow {
  readonly source_id: string;
  readonly destination_id: string;
  readonly state: number;
  readonly position: number;
}

export interface GroupWorld extends SocialWorld {
  /** 群里**群→用户**那一半的边（"这个群有哪些成员"）。 */
  groupEdges(groupId: string): Promise<readonly GroupEdgeRow[]>;
  /** 双向边里的任意一半：任何一个方向有就是"有关系"。 */
  groupEdge(groupId: string, userId: string): Promise<GroupEdgeRow | null>;
  group(groupId: string): Promise<GroupDbRow | null>;
}

export async function groupWorld(accountCount = 3): Promise<GroupWorld> {
  const world = await socialWorld(accountCount);
  return {
    ...world,
    async groupEdges(groupId) {
      const result = await env.DB.prepare(
        `SELECT source_id, destination_id, state, position FROM group_edge
         WHERE tenant_id = ?1 AND source_id = ?2 ORDER BY state, position`,
      )
        .bind(world.tenant, groupId)
        .all<GroupEdgeRow>();
      return result.results;
    },
    async groupEdge(groupId, userId) {
      return env.DB.prepare(
        `SELECT source_id, destination_id, state, position FROM group_edge
         WHERE tenant_id = ?1
           AND ((source_id = ?2 AND destination_id = ?3)
             OR (source_id = ?3 AND destination_id = ?2))
         ORDER BY source_id LIMIT 1`,
      )
        .bind(world.tenant, groupId, userId)
        .first<GroupEdgeRow>();
    },
    async group(groupId) {
      return env.DB.prepare(
        `SELECT id, creator_id, name, description, avatar_url, lang_tag, metadata,
                open, edge_count, max_count, create_time, update_time
         FROM groups WHERE tenant_id = ?1 AND id = ?2`,
      )
        .bind(world.tenant, groupId)
        .first<GroupDbRow>();
    },
  };
}

export interface GroupBody {
  readonly id: string;
  readonly creator_id: string;
  readonly name: string;
  readonly description?: string;
  readonly lang_tag?: string;
  readonly metadata?: string;
  readonly avatar_url?: string;
  readonly open: boolean;
  readonly edge_count?: number;
  readonly max_count?: number;
  readonly create_time: string;
  readonly update_time: string;
}

export function createGroupRequest(account: SocialAccount, body: unknown): Promise<Response> {
  return call("/v2/group", { method: "POST", authorization: bearer(account.token), body });
}

/** 建群并返回响应体；非 200 直接抛出，因为后面的断言都以这个群为基础。 */
export async function mustCreateGroup(
  account: SocialAccount,
  body: unknown = { name: `g-${crypto.randomUUID()}`, open: true },
): Promise<GroupBody> {
  const response = await createGroupRequest(account, body);
  if (response.status !== 200) {
    throw new Error(`建群失败：${response.status} ${await response.text()}`);
  }
  return (await response.json()) as GroupBody;
}

/** `POST /v2/group/{id}/join`（空 body）。 */
export function joinGroupRequest(account: SocialAccount, groupId: string): Promise<Response> {
  return call(`/v2/group/${groupId}/join`, { method: "POST", authorization: bearer(account.token) });
}

/** 成员管理五条的通用调用：`userIds` 在 **query** 上（见路由文件头）。 */
export function memberAction(
  account: SocialAccount,
  groupId: string,
  action: "add" | "ban" | "kick" | "promote" | "demote",
  userIds: readonly string[],
): Promise<Response> {
  const query = userIds.map((id) => `userIds=${encodeURIComponent(id)}`).join("&");
  return call(`/v2/group/${groupId}/${action}${query === "" ? "" : `?${query}`}`, {
    method: "POST",
    authorization: bearer(account.token),
  });
}

/**
 * 群组频道的频道 id：`3.<群 id>..`（`streamToChannelId` 的四段式，后两段为空）。
 *
 * 测试里直接拼而不是调 `groupChannelId()`：那样测的就是"同一个函数算两遍等于自己"。
 * 这个字符串是**线上形状**，客户端也这么拼（`channel_join` 的 target 是群 id、type 是 3）。
 */
export function groupChannelIdOf(groupId: string): string {
  return `3.${groupId}..`;
}

export interface ChannelHistoryBody {
  readonly messages?: readonly {
    readonly message_id: string;
    readonly code: number;
    readonly sender_id?: string;
    readonly username?: string;
    readonly content?: string;
  }[];
  readonly next_cursor?: string;
  readonly prev_cursor?: string;
  readonly cacheable_cursor?: string;
}

/**
 * 读群组频道的历史（`GET /v2/channel/{channelId}`，群成员才有权限）。
 *
 * 默认带上 `limit=100`：这条端点的缺省 `limit` 是 **1**（上游如此），而群组用例
 * 几乎都要"看到全部事件"——一条一条翻页会把断言写成噪声。
 */
export async function groupHistory(
  account: SocialAccount,
  groupId: string,
  query = "?limit=100",
): Promise<{ readonly status: number; readonly body: ChannelHistoryBody }> {
  const response = await call(`/v2/channel/${groupChannelIdOf(groupId)}${query}`, {
    authorization: bearer(account.token),
  });
  return { status: response.status, body: (await response.json()) as ChannelHistoryBody };
}
