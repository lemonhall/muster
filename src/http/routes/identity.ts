import {
  asObject,
  json,
  optionalString,
  optionalStringMap,
  parseBody,
  queryBool,
  queryList,
  queryValue,
} from "../body";
import { invalidArgument } from "../errors";
import type { Router } from "../router";
import {
  authenticateCustom,
  authenticateDevice,
  authenticateEmail,
  getAccount,
  getUsers,
  logout,
  refreshSession,
  updateAccount,
  type AuthenticateInput,
  type EmailInput,
} from "../../domain/identity/service";
import type { ProfilePatch } from "../../domain/identity/store";
import { registryOnline } from "../../durable/registry-call";
import { accountBody, sessionBody, usersBody } from "../../wire/identity";

/**
 * 身份/会话/账号的 REST 端点。
 *
 * 这一层只做三件事，别的一律不做：
 *   1. 把 HTTP 请求（路径参数、query、JSON body）翻译成领域层的入参；
 *   2. 调用领域层；
 *   3. 把结果按上游 protojson 的线格式序列化回 HTTP。
 *
 * 鉴权不在这里——`Router` 已经按路由类别解析好了租户与会话（对应上游的
 * `securityInterceptorFunc`），处理器直接用 `tenantEnv` / `session`。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_authenticate.go::AuthenticateDevice
 * 契约源: server/api_authenticate.go::AuthenticateEmail
 * 契约源: server/api_authenticate.go::AuthenticateCustom
 * 契约源: server/api_session.go::SessionRefresh
 * 契约源: server/api_session.go::SessionLogout
 * 契约源: server/api_account.go::GetAccount
 * 契约源: server/api_account.go::UpdateAccount
 * 契约源: server/api_user.go::GetUsers
 * 契约源: server/api.go::securityInterceptorFunc
 */

/**
 * 认证端点的请求体**就是** `apiAccountDevice` / `apiAccountCustom` 本体。
 *
 * 这不是我们的发明：上游 swagger 里 body 参数名是 `account`，grpc-gateway 的
 * `body: "account"` 语义是"把请求体解到这个字段上"，所以线上形状是顶层的
 * `{"id":"...","vars":{...}}`，而不是 `{"account":{...}}`。官方 SDK 也是这么发的。
 */
function authenticateInputOf(body: unknown, url: URL): AuthenticateInput {
  const create = queryBool(url, "create", true);
  if (body === null) return { id: "", create };
  const account = asObject(body, "account");
  const vars = optionalStringMap(account, "vars");
  const username = queryValue(url, "username");
  return {
    id: optionalString(account, "id") ?? "",
    create,
    ...(username === "" ? {} : { username }),
    ...(vars === undefined ? {} : { vars }),
  };
}

function emailInputOf(body: unknown, url: URL): EmailInput {
  const username = queryValue(url, "username");
  const create = queryBool(url, "create", true);
  if (body === null) {
    return { accountMissing: true, email: "", password: "", create };
  }
  const account = asObject(body, "account");
  const vars = optionalStringMap(account, "vars");
  return {
    email: optionalString(account, "email") ?? "",
    password: optionalString(account, "password") ?? "",
    create,
    ...(username === "" ? {} : { username }),
    ...(vars === undefined ? {} : { vars }),
  };
}

/** 只把请求里出现过的字段放进 patch：`{ key: value }` 或 `{}`。 */
function patchField(body: Record<string, unknown>, key: string): Record<string, string> {
  const value = optionalString(body, key);
  if (value === undefined) return {};
  return { [key]: value };
}

export function registerIdentityRoutes(router: Router): void {
  router.handleServerKey("POST", "/v2/account/authenticate/device", async (context) => {
    const input = authenticateInputOf(await parseBody(context.request), context.url);
    const session = await authenticateDevice(context.tenantEnv, input);
    return json(sessionBody(session));
  });

  router.handleServerKey("POST", "/v2/account/authenticate/custom", async (context) => {
    const input = authenticateInputOf(await parseBody(context.request), context.url);
    const session = await authenticateCustom(context.tenantEnv, input);
    return json(sessionBody(session));
  });

  router.handleServerKey("POST", "/v2/account/authenticate/email", async (context) => {
    const input = emailInputOf(await parseBody(context.request), context.url);
    const session = await authenticateEmail(context.tenantEnv, input);
    return json(sessionBody(session));
  });

  router.handleServerKey("POST", "/v2/account/session/refresh", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    const vars = optionalStringMap(body, "vars");
    const session = await refreshSession(context.tenantEnv, optionalString(body, "token") ?? "", vars);
    return json(sessionBody(session));
  });

  router.handleUser("POST", "/v2/session/logout", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    const token = optionalString(body, "token");
    const refreshToken = optionalString(body, "refresh_token");
    await logout(context.tenantEnv, context.session.user.id, {
      ...(token === undefined ? {} : { token }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
    });
    return json({});
  });

  router.handleUser("GET", "/v2/account", async (context) => {
    const { user, identities } = await getAccount(context.tenantEnv, context.session.user.id);
    return json(accountBody(user, identities));
  });

  router.handleUser("PUT", "/v2/account", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    // 只把**出现过**的字段放进 patch（上游用 StringValue 包装类型表达同一件事）。
    const patch: ProfilePatch = {
      ...patchField(body, "username"),
      ...patchField(body, "display_name"),
      ...patchField(body, "avatar_url"),
      ...patchField(body, "lang_tag"),
      ...patchField(body, "location"),
      ...patchField(body, "timezone"),
    };
    await updateAccount(context.tenantEnv, context.session.user.id, patch);
    return json({});
  });

  router.handleUser("GET", "/v2/user", async (context) => {
    const ids = queryList(context.url, "ids");
    const usernames = queryList(context.url, "usernames");
    // facebook_ids 在 M1 没有对应的身份来源（社交登录后置），但没有匹配项与上游"查不到"同形。
    const facebookIds = queryList(context.url, "facebook_ids", "facebookIds");
    if (ids.length === 0 && usernames.length === 0 && facebookIds.length === 0) {
      return json(usersBody([]));
    }
    for (const id of ids) {
      if (!isUuid(id)) throw invalidArgument(`ID '${id}' is not a valid system ID.`);
    }
    const users = await getUsers(context.tenantEnv, { ids, usernames });
    // 上游 `GetUsers` 会调 `FillOnlineUsers`：命中多个用户时，在线的那些人带上 online。
    const online = await registryOnline(
      context.env,
      context.tenantEnv.tenantId,
      users.map((user) => user.id),
    );
    return json(usersBody(users, online));
  });
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/** 上游用 `uuid.FromString` 判系统 ID；这里只接受规范带连字符形式。 */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
