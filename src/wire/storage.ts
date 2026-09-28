import type { Ack, StorageObjectRow } from "../domain/storage/objects";
import { formatTimestamp } from "./identity";

/**
 * 存储域的 JSON 线格式。
 *
 * 形状规则与身份域完全一致（同一个 upstream marshaler：`protojson` + `UseProtoNames`），
 * 这里只把**存储特有的两处**写清楚：
 *
 *   1. `permission_read` / `permission_write` 是 int32 标量，**值为 0 时整条省略**。
 *      所以一个 "系统用户可读、任何人都不能写" 的对象在线上是 `{"permission_read":0,...}`
 *      的省略形式，而不是显式的 0。客户端 SDK 把它当"缺省 = 0"处理，这一点不能自作主张改。
 *   2. `create_time` / `update_time` 永远是**存在的消息字段**（上游给每个对象都构造了
 *      `&timestamppb.Timestamp{}`），所以它们总是被序列化成 RFC3339 字符串，不会省略。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::StartApiServer
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.proto::message StorageObject
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.proto::message StorageObjectAck
 */

export function storageObjectBody(row: StorageObjectRow): Record<string, unknown> {
  return {
    collection: row.collection,
    key: row.key,
    user_id: row.user_id,
    value: row.value,
    version: row.version,
    ...(row.read_perm === 0 ? {} : { permission_read: row.read_perm }),
    ...(row.write_perm === 0 ? {} : { permission_write: row.write_perm }),
    create_time: formatTimestamp(row.create_time),
    update_time: formatTimestamp(row.update_time),
  };
}

export function storageObjectAckBody(ack: Ack): Record<string, unknown> {
  return {
    collection: ack.collection,
    key: ack.key,
    version: ack.version,
    user_id: ack.userId,
    create_time: formatTimestamp(ack.createTime),
    update_time: formatTimestamp(ack.updateTime),
  };
}

/** `StorageObjects`：空 repeated 字段整体省略，所以没有命中时是 `{}`。 */
export function storageObjectsBody(rows: readonly StorageObjectRow[]): Record<string, unknown> {
  if (rows.length === 0) return {};
  return { objects: rows.map(storageObjectBody) };
}

/** `StorageObjectAcks`：同上。 */
export function storageObjectAcksBody(acks: readonly Ack[]): Record<string, unknown> {
  if (acks.length === 0) return {};
  return { acks: acks.map(storageObjectAckBody) };
}

/** `StorageObjectList`：`cursor` 为空串时同样省略（protojson 的零值规则）。 */
export function storageObjectListBody(
  rows: readonly StorageObjectRow[],
  cursor: string,
): Record<string, unknown> {
  return {
    ...(rows.length === 0 ? {} : { objects: rows.map(storageObjectBody) }),
    ...(cursor === "" ? {} : { cursor }),
  };
}
