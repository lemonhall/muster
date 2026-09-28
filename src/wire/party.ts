/**
 * 派对目录的线格式（protojson + `UseProtoNames`）。
 *
 * `api.Party` 只有五个字段（`party_id` / `open` / `hidden` / `max_size` / `label`），
 * 没有创建时间——目录条目的 `create_time` 只住在索引里，用来排序，不对外暴露。
 *
 * 三条容易写错的规则：
 *
 * 1. 零值整体省略：`open: false`、`hidden: false`、`max_size: 0`、`label: ""`
 *    在响应里都不出现；客户端反序列化之后仍然是同一个值；
 * 2. **空列表整个 `parties` 键省略**（protojson 对 repeated 字段的规矩），
 *    不是 `"parties": []`；
 * 3. `cursor` 为空串时同样省略——上游 `PartyList{Cursor: ""}` 的 protojson 形状。
 *
 * 目录里永远不会出现 `hidden: true` 的条目（数据源就带 `WHERE hidden = 0`），
 * 所以 `hidden` 这一位在本响应里恒不出现；保留它的映射只是为了让"条目形状"
 * 与 proto 一一对应。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/party
 * 契约源: server/api_party.go::ApiServer.ListParties
 *
 * REQ-0001-019
 */

import type { PartyRecord } from "../domain/party/types";

/** `api.Party`。 */
export function partyBody(record: PartyRecord): Record<string, unknown> {
  return {
    party_id: record.partyId,
    ...(record.open ? { open: true } : {}),
    ...(record.hidden ? { hidden: true } : {}),
    ...(record.maxSize === 0 ? {} : { max_size: record.maxSize }),
    // 上游 `LabelString` 在创建时被规整成 `"{}"`，所以它其实**总是**非空——
    // 除非有人手工把库里那行改成空串；这时按"零值省略"的规矩省掉。
    ...(record.label === "" ? {} : { label: record.label }),
  };
}

/** `api.PartyList`。空列表时 `parties` 与空 `cursor` 都省略。 */
export function partyListBody(page: {
  readonly parties: readonly PartyRecord[];
  readonly cursor: string;
}): Record<string, unknown> {
  return {
    ...(page.parties.length === 0 ? {} : { parties: page.parties.map(partyBody) }),
    ...(page.cursor === "" ? {} : { cursor: page.cursor }),
  };
}
