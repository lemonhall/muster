/**
 * `nk` 的**数据面**：存储、钱包、通知。群组那一组在 `capability-groups.ts`。
 *
 * 三条贯穿全文件的纪律：
 *
 * 1. **租户来自闭包，不来自参数**。每个函数都闭在 `(env, tenantId)` 上，隔离区的
 *    模块无论传什么参数都改不了"我是哪个租户"（DoD 5）。这是多租户下代码级隔离的
 *    落点：租户之间的数据隔离不靠模块作者自觉。
 * 2. **写到既有领域服务里，不另写一套 SQL**。`storageWrite` 用的是 REST 那条
 *    `writeObjects`（权威写、跳过写权限），所以"模块写进去的对象"和"客户端读到的
 *    对象"是同一张表、同一套语义。
 * 3. **值一律按上游的形状返回**：`storageRead` 的 `value` 是**解码后的对象**
 *    （上游 `runtime_javascript_nakama.go` 里 `json.Unmarshal` 之后才放进结果），
 *    nil 所有者回 `null` 而不是空串。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.storageRead
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.storageWrite
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.walletUpdate
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.notificationSend
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.notificationsSend
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.notificationsDelete
 *
 * REQ-0001-020
 */

import type { Bindings } from "../env";
import { updateWallet } from "../domain/competitive/wallet/service";
import { deleteNotificationsByIds } from "../domain/notifications/store";
import { sendNotifications, type SendNotificationInput } from "../domain/notifications/service";
import {
  NIL_USER_ID,
  readObjects,
  writeObjects,
  type ReadObjectId,
  type StorageObjectRow,
  type WriteOp,
} from "../domain/storage/objects";

/** 数据面需要的最小上下文。`now` 在调用点算，方便测试把时间钉住。 */
export interface DataContext {
  readonly env: Bindings;
  readonly tenantId: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

/** 模块给的 user id：空 / 缺省 = 上游的 `uuid.Nil`（全局对象）。 */
function ownerOf(record: Record<string, unknown>): string {
  const raw = textOf(record, "userId");
  return raw === "" ? NIL_USER_ID : raw.toUpperCase();
}

function decodeValue(row: StorageObjectRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // 库里出现非对象值只可能来自平台自己写坏的数据；模块拿到空对象比拿到异常有用。
    return {};
  }
}

function objectBody(row: StorageObjectRow): Record<string, unknown> {
  return {
    key: row.key,
    collection: row.collection,
    userId: row.user_id === NIL_USER_ID ? null : row.user_id,
    version: row.version,
    permissionRead: row.read_perm,
    permissionWrite: row.write_perm,
    createTime: row.create_time,
    updateTime: row.update_time,
    value: decodeValue(row),
  };
}

/** 把任意值折成上游要的 JSON 文本（模块可以直接给对象，不用自己 stringify）。 */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function storageRead(data: DataContext, ids: unknown): Promise<Record<string, unknown>[]> {
  const list = asArray(ids, "objectIds");
  if (list.length === 0) return Promise.resolve([]);
  const objectIds: ReadObjectId[] = list.map((entry) => {
    const item = asRecord(entry, "objectId");
    return { collection: textOf(item, "collection"), key: textOf(item, "key"), userId: ownerOf(item) };
  });
  // 权威读：运行时读得到任何对象（上游传的是 `uuid.Nil` 做 owner，那一支不加权限条件）。
  return readObjects(
    { db: data.env.DB, tenantId: data.tenantId, nowSec: nowSeconds() },
    NIL_USER_ID,
    objectIds,
    { authoritative: true },
  ).then((rows) => rows.map(objectBody));
}

/**
 * 批量写。上游允许**每条对象各有自己的所有者**，而领域层的 `writeObjects` 一次只认
 * 一个所有者，所以这里按所有者分组、逐组落库，最后**按请求顺序**把 acks 拼回去。
 *
 * 代价是"跨所有者的写不再是同一个事务"——上游那一条 SQL 里确实是同一个事务。
 * 这一点登记在 ECN-0012 的影响面里：模块一次写多个用户的对象时，失败可能只回滚一部分。
 */
async function storageWrite(data: DataContext, objects: unknown): Promise<Record<string, unknown>[]> {
  const list = asArray(objects, "objects");
  if (list.length === 0) return [];
  const groups = new Map<string, { op: WriteOp; index: number }[]>();
  list.forEach((entry, index) => {
    const item = asRecord(entry, "object");
    const owner = ownerOf(item);
    const op: WriteOp = {
      collection: textOf(item, "collection"),
      key: textOf(item, "key"),
      value: valueText(item["value"]),
      version: textOf(item, "version"),
      permissionRead: typeof item["permissionRead"] === "number" ? (item["permissionRead"] as number) : 1,
      permissionWrite: typeof item["permissionWrite"] === "number" ? (item["permissionWrite"] as number) : 1,
    };
    const bucket = groups.get(owner);
    if (bucket === undefined) groups.set(owner, [{ op, index }]);
    else bucket.push({ op, index });
  });

  const acks: Record<string, unknown>[] = new Array<Record<string, unknown>>(list.length);
  for (const [owner, bucket] of groups) {
    const results = await writeObjects(
      { db: data.env.DB, tenantId: data.tenantId, nowSec: nowSeconds() },
      owner,
      bucket.map((item) => item.op),
      { authoritative: true },
    );
    results.forEach((ack, position) => {
      const index = bucket[position]?.index;
      if (index === undefined) return;
      acks[index] = { ...ack, userId: ack.userId === NIL_USER_ID ? null : ack.userId };
    });
  }
  return acks;
}

async function walletUpdate(data: DataContext, args: readonly unknown[]): Promise<unknown> {
  const userId = String(args[0] ?? "");
  const changeset: Record<string, number> = {};
  const raw = asRecord(args[1], "changeset");
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number") throw new TypeError(`changeset.${key} must be a number`);
    changeset[key] = value;
  }
  const metadata = args[2] === undefined || args[2] === null ? "" : JSON.stringify(args[2]);
  const updateLedger = args[3] === true;
  const result = await updateWallet(
    data.env.DB,
    data.tenantId,
    nowSeconds(),
    userId.toUpperCase(),
    changeset,
    metadata,
    updateLedger,
  );
  return result === null ? [] : [result];
}

function notificationOf(entry: unknown): SendNotificationInput {
  const item = asRecord(entry, "notification");
  const code = item["code"];
  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw new TypeError("notification.code must be an integer");
  }
  return {
    userId: textOf(item, "userId").toUpperCase(),
    subject: textOf(item, "subject"),
    content: valueText(item["content"]),
    code,
    senderId: textOf(item, "senderId") === "" ? NIL_USER_ID : textOf(item, "senderId").toUpperCase(),
  };
}

async function notificationsSend(data: DataContext, list: unknown): Promise<void> {
  const entries = asArray(list, "notifications");
  if (entries.length === 0) return;
  await sendNotifications(data.env, data.tenantId, nowSeconds(), entries.map(notificationOf));
}

/** 上游 JS 的 `notificationsDelete` 收的是 `{userId, notificationId}`；纯 id 串也接受。 */
function deleteIdsOf(list: unknown): string[] {
  return asArray(list, "notificationIds").map((entry) =>
    typeof entry === "string" ? entry : textOf(asRecord(entry, "notificationId"), "notificationId"),
  );
}

export function buildNkData(data: DataContext): Record<string, unknown> {
  return {
    storageRead: (ids: unknown) => storageRead(data, ids),
    storageWrite: (objects: unknown) => storageWrite(data, objects),
    walletUpdate: (...args: unknown[]) => walletUpdate(data, args),
    notificationsSend: (list: unknown) => notificationsSend(data, list),
    notificationSend: (userId: unknown, subject: unknown, content: unknown, code: unknown, senderId?: unknown) =>
      notificationsSend(data, [
        { userId, subject, content, code, ...(senderId === undefined ? {} : { senderId }) },
      ]),
    notificationsDelete: async (ids: unknown) => {
      await deleteNotificationsByIds(data.env.DB, data.tenantId, deleteIdsOf(ids));
    },
  };
}
