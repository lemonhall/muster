import { JSON_CONTENT_TYPE } from "../grpc";
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
 * 请求体里的字段名有两种合法写法。
 *
 * `UseProtoNames: true` 只影响**输出**；protojson 的**输入**同时接受 proto 原名
 * （`display_name`）与 lowerCamelCase 的 JSON 名（`displayName`）。官方 SDK 发的就是
 * 后者，所以两种都必须认，只认一种会把 SDK 挡在门外。
 */
const SNAKE_TO_JSON: Readonly<Record<string, string>> = {
  display_name: "displayName",
  avatar_url: "avatarUrl",
  lang_tag: "langTag",
  refresh_token: "refreshToken",
  facebook_ids: "facebookIds",
};

function readField(container: Record<string, unknown>, key: string): unknown {
  const jsonName = SNAKE_TO_JSON[key];
  if (jsonName !== undefined && jsonName in container) return container[jsonName];
  return container[key];
}

/**
 * 解析请求体。空 body 与坏 JSON 的 code 都是 InvalidArgument（400），只有消息不同。
 *
 * 返回 `unknown` 而不是 `Record<string, unknown>`：`null` 是一个**有意义的输入**
 * （对应上游 `in.Account == nil`，"认证请求里没给 account"），不能与"坏 JSON"混为一谈。
 */
async function parseBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === "") {
    // protojson 解码空输入报的就是这句。
    throw invalidArgument("unexpected EOF");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidArgument("Invalid JSON body.");
  }
}

/** 要求请求体是个 JSON 对象（`null` 由调用方按自己的语义处理）。 */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArgument(`Invalid ${label}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(container: Record<string, unknown>, key: string): string | undefined {
  const value = readField(container, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidArgument(`Invalid ${key}: expected a string.`);
  return value;
}

function optionalStringMap(
  container: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = readField(container, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument(`Invalid ${key}: expected an object.`);
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== "string") {
      throw invalidArgument(`Invalid ${key}: values must be strings.`);
    }
    result[entryKey] = entryValue;
  }
  return result;
}

/** query 参数取单值；没有就是 `""`（与上游 `req.FormValue` 的空值语义一致）。 */
function queryValue(url: URL, ...names: readonly string[]): string {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) return value;
  }
  return "";
}

/** query 参数取多值（`?ids=a&ids=b`）。上游 swagger 声明的是 `collectionFormat: multi`。 */
function queryList(url: URL, ...names: readonly string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    values.push(...url.searchParams.getAll(name));
  }
  return values;
}

/**
 * query 参数取布尔。取值集合照 Go 的 `strconv.ParseBool`（grpc-gateway 就调它），
 * 缺省值由调用方给：上游对 `create` 的语义是 `in.Create == nil || in.Create.Value`，
 * 即**不传 = true**。
 */
function queryBool(url: URL, name: string, fallback: boolean): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (["1", "t", "T", "TRUE", "true", "True"].includes(raw)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(raw)) return false;
  throw invalidArgument(`invalid value for boolean field: ${name}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

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
    return json(usersBody(users));
  });
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/** 上游用 `uuid.FromString` 判系统 ID；这里只接受规范带连字符形式。 */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
