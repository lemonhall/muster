import { env } from "cloudflare:test";

import { authenticateDeviceOrFail, bearer, call, createTenant } from "./tenants";

/**
 * M5 社交套件的工装：一个随机租户 + 若干**真实注册出来**的账号。
 *
 * 为什么走真实认证端点而不是直接写 `users` 表：好友端点按 **username** 解析目标，
 * 而 username 是认证域在注册时铸出来的（随机 10 个字母）。手写 `users` 行能造出
 * "用户名恰好能对上"的假象，却证明不了"按 username 加好友"这条路真的通。
 *
 * 每个用例一个随机租户：好友边、群组、通知都挂在租户上，随机租户等价于"每个用例
 * 一套全新的数据"，比"跑完清表"可靠（同一文件里的 D1 是持久的）。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export interface SocialAccount {
  readonly id: string;
  readonly username: string;
  readonly token: string;
}

export interface SocialWorld {
  readonly tenant: string;
  readonly serverKey: string;
  /** 开局建好的账号，顺序与请求顺序一致。 */
  readonly accounts: readonly SocialAccount[];
  /** 再开一个账号（不进 `accounts` 数组）。 */
  newAccount(): Promise<SocialAccount>;
  as(account: SocialAccount, path: string, options?: RequestOptions): Promise<Response>;
  /** 直接查好友边：断言必须读库里的行，不能只看 HTTP 响应体。 */
  edge(source: string, destination: string): Promise<EdgeRow | null>;
  /** 直接查通知。 */
  notifications(userId: string): Promise<NotificationRow[]>;
  /** 好友/群组边计数。 */
  edgeCount(userId: string): Promise<number>;
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
}

export interface EdgeRow {
  readonly state: number;
  readonly position: number;
  readonly metadata: string;
}

export interface NotificationRow {
  readonly id: string;
  readonly user_id: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
  readonly sender_id: string;
  readonly create_time: number;
}

export async function socialWorld(accountCount = 2): Promise<SocialWorld> {
  const tenant = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenant}`;
  await createTenant(tenant, serverKey, "social");

  const newAccount = async (): Promise<SocialAccount> => {
    const session = await authenticateDeviceOrFail(
      { id: tenant, serverKey },
      `dev-${crypto.randomUUID()}`,
    );
    const response = await call("/v2/account", { authorization: bearer(session.token) });
    if (response.status !== 200) throw new Error(`读账号失败：${response.status}`);
    const account = (await response.json()) as { user: { id: string; username: string } };
    return { id: account.user.id, username: account.user.username, token: session.token };
  };

  const accounts: SocialAccount[] = [];
  for (let index = 0; index < accountCount; index += 1) accounts.push(await newAccount());

  return {
    tenant,
    serverKey,
    accounts,
    newAccount,
    as(account, path, options = {}) {
      return call(path, {
        method: options.method ?? "GET",
        authorization: bearer(account.token),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    },
    async edge(source, destination) {
      return env.DB.prepare(
        "SELECT state, position, metadata FROM user_edge WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3",
      )
        .bind(tenant, source, destination)
        .first<EdgeRow>();
    },
    async notifications(userId) {
      const result = await env.DB.prepare(
        "SELECT id, user_id, subject, content, code, sender_id, create_time FROM notifications WHERE tenant_id = ?1 AND user_id = ?2 ORDER BY create_time, id",
      )
        .bind(tenant, userId)
        .all<NotificationRow>();
      return result.results;
    },
    async edgeCount(userId) {
      const row = await env.DB.prepare("SELECT edge_count FROM users WHERE tenant_id = ?1 AND id = ?2")
        .bind(tenant, userId)
        .first<{ edge_count: number }>();
      return row?.edge_count ?? -1;
    },
  };
}

/** `?ids=a&ids=b` 形式的 query 段。 */
export function idsQuery(ids: readonly string[]): string {
  return ids.map((id) => `ids=${encodeURIComponent(id)}`).join("&");
}

/** 发一条好友请求（`POST /v2/friend?ids=...`，参数在 query 上——见路由文件头）。 */
export function requestFriend(from: SocialAccount, to: SocialAccount): Promise<Response> {
  return call(`/v2/friend?${idsQuery([to.id])}`, {
    method: "POST",
    authorization: bearer(from.token),
  });
}

/** 双向加好友：两边都发一次请求，结果是一对 `FRIEND` 边（上游 addFriend 的等价路径）。 */
export async function becomeFriends(one: SocialAccount, other: SocialAccount): Promise<void> {
  const first = await requestFriend(one, other);
  const second = await requestFriend(other, one);
  if (first.status !== 200 || second.status !== 200) {
    throw new Error(`加好友失败：${first.status}/${second.status}`);
  }
}

export async function errorBody(response: Response): Promise<{ code: number; message: string }> {
  return (await response.json()) as { code: number; message: string };
}
