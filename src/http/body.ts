import { JSON_CONTENT_TYPE } from "./grpc";
import { invalidArgument } from "./errors";

/**
 * HTTP 请求 → 领域入参的翻译工具。
 *
 * 这些规则**全部来自上游 gateway 的 marshaler 配置**（`protojson` + `UseProtoNames`），
 * 不是本项目的口味：
 *
 * - 输出用 proto 原名（snake_case），但**输入同时接受** snake_case 与 lowerCamelCase
 *   （protojson 的字段名解析规则），所以官方 SDK 发的 `displayName` 与手写的
 *   `display_name` 都必须认；
 * - 缺字段 = 零值；`null` 在只有消息类型的地方是**有意义的输入**（"没给这个对象"），
 *   不能与"JSON 坏了"混为一谈；
 * - 非法 JSON 是 `InvalidArgument`，空 body 是 protojson 的 `unexpected EOF`。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::StartApiServer
 */

/**
 * proto 原名 → JSON 名。只列**两种名字不一样**的字段：其余字段两者的写法相同，
 * 走同一张表只是白写。新增字段时如果 camelCase 与 snake_case 不同，必须加进来。
 */
const PROTO_TO_JSON_NAME: Readonly<Record<string, string>> = {
  display_name: "displayName",
  avatar_url: "avatarUrl",
  lang_tag: "langTag",
  refresh_token: "refreshToken",
  facebook_ids: "facebookIds",
  object_ids: "objectIds",
  permission_read: "permissionRead",
  permission_write: "permissionWrite",
  user_id: "userId",
  create_time: "createTime",
  update_time: "updateTime",
};

export function readField(container: Record<string, unknown>, key: string): unknown {
  const jsonName = PROTO_TO_JSON_NAME[key];
  if (jsonName !== undefined && jsonName in container) return container[jsonName];
  return container[key];
}

/**
 * 解析请求体。空 body 与坏 JSON 的 code 都是 InvalidArgument（400），只有消息不同。
 *
 * 返回 `unknown` 而不是 `Record<string, unknown>`：`null` 是一个**有意义的输入**
 * （对应上游的 `in.Account == nil` 之类），不能与"坏 JSON"混为一谈。
 */
export async function parseBody(request: Request): Promise<unknown> {
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
export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArgument(`Invalid ${label}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

/** 要求请求体是数组（`object_ids`/`objects` 这类 repeated 字段的容器）。 */
export function optionalArray(container: Record<string, unknown>, key: string): unknown[] {
  const value = readField(container, key);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidArgument(`Invalid ${key}: expected an array.`);
  return value;
}

export function optionalString(container: Record<string, unknown>, key: string): string | undefined {
  const value = readField(container, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidArgument(`Invalid ${key}: expected a string.`);
  return value;
}

/** 可选的 int32（上游用 `google.protobuf.Int32Value` 表达"给了没有"）。 */
export function optionalInt(container: Record<string, unknown>, key: string): number | undefined {
  const value = readField(container, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidArgument(`Invalid ${key}: expected an integer.`);
  }
  return value;
}

export function optionalStringMap(
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
export function queryValue(url: URL, ...names: readonly string[]): string {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) return value;
  }
  return "";
}

/** query 参数取多值（`?ids=a&ids=b`）。上游 swagger 声明的是 `collectionFormat: multi`。 */
export function queryList(url: URL, ...names: readonly string[]): string[] {
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
export function queryBool(url: URL, name: string, fallback: boolean): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (["1", "t", "T", "TRUE", "true", "True"].includes(raw)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(raw)) return false;
  throw invalidArgument(`invalid value for boolean field: ${name}`);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}
