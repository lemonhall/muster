import type { IdentityRow, UserRow } from "../domain/identity/store";

/**
 * 对外的 JSON 线格式。
 *
 * 上游 gateway 的 marshaler 配置是 `protojson` + `UseProtoNames: true`
 * （`server/api.go`），这带来三条**必须照搬**的规则：
 *   1. 字段名用 proto 原名（snake_case），不是 camelCase；
 *   2. 零值/空值字段**整个省略**（没有 `EmitUnpopulated`），
 *      所以 `created=false` 时响应里不会出现 `"created"` 键；
 *   3. 时间戳序列化成 RFC3339，且整秒不带小数（`2026-09-28T13:00:00Z`）。
 *
 * 这三条是本文件的全部职责：领域层只管值，形状在这里定型。
 */

export function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/u, "Z");
}

export interface SessionWire {
  readonly created: boolean;
  readonly token: string;
  readonly refreshToken: string;
}

export function sessionBody(session: SessionWire): Record<string, unknown> {
  return {
    // created=false 按 protojson 规则省略。
    ...(session.created ? { created: true } : {}),
    token: session.token,
    refresh_token: session.refreshToken,
  };
}

export function userBody(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    // 下面这些空字符串字段在 protojson 下整条省略。
    ...(user.display_name === "" ? {} : { display_name: user.display_name }),
    ...(user.avatar_url === "" ? {} : { avatar_url: user.avatar_url }),
    ...(user.lang_tag === "" ? {} : { lang_tag: user.lang_tag }),
    ...(user.location === "" ? {} : { location: user.location }),
    ...(user.timezone === "" ? {} : { timezone: user.timezone }),
    ...(user.metadata === "" ? {} : { metadata: user.metadata }),
    create_time: formatTimestamp(user.create_time),
    update_time: formatTimestamp(user.update_time),
  };
}

/**
 * Account 消息。`wallet` 上游默认是 `"{}"`（表示"没有任何货币"）——
 * 钱包本身是 M6 的功能，这里如实表示"还没有钱包数据"，不是假装有钱包。
 *
 * `disable_time` **不发**：上游 `ApiServer.GetAccount` 在返回前显式把它清成 nil
 * （源码原话："User-facing account retrieval does not expose disable time for now."），
 * 所以即使账号被封，GET /v2/account 也不会带上这个字段。
 *
 * `providers` 只装"provider 关联的身份"（社交登录那种）。M1 的 email 身份在上游是
 * users 表的一列、不算 provider 身份，所以这里不把它塞进 providers。
 */
export function accountBody(user: UserRow, identities: readonly IdentityRow[]): Record<string, unknown> {
  const devices = identities.filter((identity) => identity.provider === "device");
  const custom = identities.find((identity) => identity.provider === "custom");

  return {
    user: userBody(user),
    wallet: "{}",
    ...(user.email === null || user.email === "" ? {} : { email: user.email }),
    ...(devices.length === 0 ? {} : { devices: devices.map((device) => ({ id: device.provider_id })) }),
    ...(custom === undefined ? {} : { custom_id: custom.provider_id }),
    ...(user.verify_time === 0 ? {} : { verify_time: formatTimestamp(user.verify_time) }),
  };
}

/** Users 消息：没有命中时上游返回 `{}`（空 repeated 字段被省略）。 */
export function usersBody(users: readonly UserRow[]): Record<string, unknown> {
  if (users.length === 0) return {};
  return { users: users.map(userBody) };
}
