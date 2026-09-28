import {
  asObject,
  json,
  optionalArray,
  optionalInt,
  optionalString,
  parseBody,
  queryValue,
} from "../body";
import { invalidArgument } from "../errors";
import type { Router } from "../router";
import type { TenantEnv } from "../../domain/identity/service";
import {
  NIL_USER_ID,
  deleteObjects,
  listObjects,
  readObjects,
  writeObjects,
  type DeleteOp,
  type ReadObjectId,
  type WriteOp,
} from "../../domain/storage/objects";
import {
  storageObjectAcksBody,
  storageObjectListBody,
  storageObjectsBody,
} from "../../wire/storage";
import { requestCaller, runRequestAfter, runRequestBefore } from "../../runtime/hooks";

/**
 * 存储引擎的 REST 端点。
 *
 * 这一层只做三件事：HTTP → 领域入参、调领域层、按 protojson 序列化回去。
 * 校验的**顺序与文案**逐字取自上游 `server/api_storage.go`，因为官方 SDK 会按
 * 这些字符串与状态码做分支（例如把 `Storage write rejected - version check failed.`
 * 当成"重读后重试"的信号）。
 *
 * 多租户：所有端点走 `handleUser`，租户由令牌的 `gid` claim 解析（ECN-0001），
 * 领域层的每条语句都带 `tenant_id`。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_storage.go::ReadStorageObjects
 * 契约源: server/api_storage.go::WriteStorageObjects
 * 契约源: server/api_storage.go::DeleteStorageObjects
 * 契约源: server/api_storage.go::ListStorageObjects
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/storage
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/storage/delete
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/storage/{collection}
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/storage/{collection}/{userId}
 */

const INVALID_COLLECTION_OR_KEY = "Invalid collection or key value supplied. They must be set.";
const INVALID_USER_ID = "Invalid user ID - make sure user ID is a valid UUID.";
const INVALID_READ_PERMISSION = "Invalid Read permission supplied. It must be either 0, 1 or 2.";
const INVALID_WRITE_PERMISSION = "Invalid Write permission supplied. It must be either 0 or 1.";
const INVALID_VALUE = "Value must be a JSON object.";
const INVALID_LIMIT = "Invalid limit - limit must be between 1 and 100.";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/**
 * 把线上的 user id 规范成本项目铸出来的形态。
 *
 * UUID 的十六进制大小写在协议上是等价的（上游用 Postgres 的 `uuid` 类型比较，天生不区分），
 * 而我们把所有者存成文本，所以**在入口处统一大小写**才是等价的实现；否则一个客户端
 * 回传小写 id 就会查不到自己的对象。空串是上游的 `uuid.Nil`（全局对象）。
 */
function canonicalUserId(raw: string): string {
  if (raw === "") return NIL_USER_ID;
  return raw.toUpperCase();
}

/** 客户端传来的 user id 必须能解析（上游这里不接受全零 UUID：那是"系统对象"的写法）。 */
function requireUserId(raw: string): string {
  if (!UUID_RE.test(raw) || raw === NIL_USER_ID) throw invalidArgument(INVALID_USER_ID);
  return canonicalUserId(raw);
}

/** 列表路径上的 user id：上游只要求"能解析"，全零是合法的（= 全局对象）。 */
function requireListOwnerId(raw: string): string {
  if (!UUID_RE.test(raw)) throw invalidArgument(INVALID_USER_ID);
  return canonicalUserId(raw);
}

function requireCollectionAndKey(collection: string, key: string): void {
  if (collection === "" || key === "") throw invalidArgument(INVALID_COLLECTION_OR_KEY);
}

/** 读对象集合：`object_ids` 里的每一项。 */
function readIdsOf(body: Record<string, unknown>): ReadObjectId[] {
  const ids: ReadObjectId[] = [];
  for (const entry of optionalArray(body, "object_ids")) {
    const item = asObject(entry, "object_id");
    const collection = optionalString(item, "collection") ?? "";
    const key = optionalString(item, "key") ?? "";
    requireCollectionAndKey(collection, key);
    const userId = optionalString(item, "user_id") ?? "";
    ids.push({
      collection,
      key,
      userId: userId === "" ? NIL_USER_ID : requireUserId(userId),
    });
  }
  return ids;
}

/** 写对象集合：`objects` 里的每一项。校验顺序照抄上游（先 collection/key，再权限，再 value）。 */
function writeOpsOf(body: Record<string, unknown>): WriteOp[] {
  const ops: WriteOp[] = [];
  for (const entry of optionalArray(body, "objects")) {
    const item = asObject(entry, "object");
    const collection = optionalString(item, "collection") ?? "";
    const key = optionalString(item, "key") ?? "";
    const value = optionalString(item, "value") ?? "";
    requireCollectionAndKey(collection, key);
    if (value === "") throw invalidArgument(INVALID_COLLECTION_OR_KEY);

    const permissionRead = optionalInt(item, "permission_read");
    if (permissionRead !== undefined && (permissionRead < 0 || permissionRead > 2)) {
      throw invalidArgument(INVALID_READ_PERMISSION);
    }
    const permissionWrite = optionalInt(item, "permission_write");
    if (permissionWrite !== undefined && (permissionWrite < 0 || permissionWrite > 1)) {
      throw invalidArgument(INVALID_WRITE_PERMISSION);
    }

    // 上游：`json.Valid(value) && bytes.TrimSpace(value)[0] == '{'`。
    // 注意它要求**外层是个对象**，数组与标量都不行。
    const trimmed = value.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) throw invalidArgument(INVALID_VALUE);
    try {
      JSON.parse(value);
    } catch {
      throw invalidArgument(INVALID_VALUE);
    }

    ops.push({
      collection,
      key,
      value,
      version: optionalString(item, "version") ?? "",
      // 上游 permissionRead()/permissionWrite() 的缺省值是 1（不是 0）。
      permissionRead: permissionRead ?? 1,
      permissionWrite: permissionWrite ?? 1,
    });
  }
  return ops;
}

/** 删除对象集合：`object_ids` 里的每一项。 */
function deleteOpsOf(body: Record<string, unknown>): DeleteOp[] {
  const ops: DeleteOp[] = [];
  for (const entry of optionalArray(body, "object_ids")) {
    const item = asObject(entry, "object_id");
    const collection = optionalString(item, "collection") ?? "";
    const key = optionalString(item, "key") ?? "";
    requireCollectionAndKey(collection, key);
    ops.push({ collection, key, version: optionalString(item, "version") ?? "" });
  }
  return ops;
}

/** `limit`：缺省 1；给了就必须在 1..100（Int32Value 的"给了没有"语义）。 */
function limitOf(url: URL): number {
  const raw = queryValue(url, "limit");
  if (raw === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw invalidArgument(INVALID_LIMIT);
  return parsed;
}

export function registerStorageRoutes(router: Router): void {
  router.handleUser("POST", "/v2/storage", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    const ids = readIdsOf(body);
    if (ids.length === 0) return json({});
    const objects = await readObjects(context.tenantEnv, context.session.user.id, ids);
    return json(storageObjectsBody(objects));
  });

  router.handleUser("PUT", "/v2/storage", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    // 运行时 before hook 排在校验**之前**（上游 `WriteStorageObjects` 就是这个顺序）；
    // 它看到的是客户端原样送上来的 body，拒绝时给 404 `Requested resource was not found.`。
    const caller = requestCaller(context.session.user.id, context.session.user.username);
    await runRequestBefore(context.env, context.tenantEnv.tenantId, caller, "WriteStorageObjects", body);
    const ops = writeOpsOf(body);
    if (ops.length === 0) return json({});
    const acks = await writeObjects(context.tenantEnv, context.session.user.id, ops);
    const payload = storageObjectAcksBody(acks);
    await runRequestAfter(context.env, context.tenantEnv.tenantId, caller, "WriteStorageObjects", payload);
    return json(payload);
  });

  router.handleUser("PUT", "/v2/storage/delete", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    const ops = deleteOpsOf(body);
    if (ops.length > 0) {
      await deleteObjects(context.tenantEnv, context.session.user.id, ops);
    }
    return json({});
  });

  /**
   * 列表端点的公共路径：`/v2/storage/{collection}` 与 `/v2/storage/{collection}/{userId}`
   * 只差 "ownerId 从 query 还是从路径来"，其余完全一致。
   *
   * 校验顺序照抄上游：**先 limit，后 user_id** —— 两个都错时客户端看到的是 limit 那条。
   */
  const listRoute = async (
    tenantEnv: TenantEnv,
    callerId: string,
    collection: string,
    rawOwner: string,
    url: URL,
  ): Promise<Response> => {
    const limit = limitOf(url);
    const ownerId = rawOwner === "" ? null : requireListOwnerId(rawOwner);
    const result = await listObjects(tenantEnv, callerId, {
      collection,
      ownerId,
      limit,
      cursor: queryValue(url, "cursor"),
    });
    return json(storageObjectListBody(result.objects, result.cursor));
  };

  router.handleUser("GET", "/v2/storage/{collection}", async (context) =>
    listRoute(
      context.tenantEnv,
      context.session.user.id,
      context.params["collection"] ?? "",
      queryValue(context.url, "userId", "user_id"),
      context.url,
    ),
  );

  router.handleUser("GET", "/v2/storage/{collection}/{userId}", async (context) =>
    listRoute(
      context.tenantEnv,
      context.session.user.id,
      context.params["collection"] ?? "",
      context.params["userId"] ?? "",
      context.url,
    ),
  );
}
