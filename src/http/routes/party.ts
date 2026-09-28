/**
 * 派对目录：`GET /v2/party`。
 *
 * 校验顺序照抄上游 `ApiServer.ListParties`：
 * `limit` 范围 → 解游标（query/limit/open 三项一致性）→ 查索引。
 * **只有 `limit` 的坏值是 `InvalidArgument`**；解游标失败与查询失败都进
 * `Internal` + `Error listing matches.`——上游把这两类错误都记进日志再回同一句话。
 *
 * 两条只有这里才知道的语义：
 *   - `query` 在进索引**之前**被规整：空串 → `"*"`（匹配全部），于是"没给 query"
 *     与"给了空 query"是同一条路，游标里存的也是规整后的值；
 *   - `showHidden` 恒为 `false`（上游写死的），隐藏派对**不进目录**。本项目把这件事
 *     压进 SQL（`WHERE hidden = 0`），所以领域层不再判一次。
 *
 * 与上游的一处形态差异：游标的编码。上游用 `gob` 编码 `PartyListCursor` 再
 * 做 base64url；本项目用 base64url(JSON)，两者的**语义**（三项一致性校验与
 * 偏移量）逐条对齐，字节形状不兼容。客户端只该原样回传游标，所以这处差异
 * 在官方 SDK 上不可见。记在 ECN-0013 偏差 3。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_party.go::ApiServer.ListParties
 * 契约源: server/party_registry.go::LocalPartyRegistry.PartyList
 *
 * REQ-0001-019
 */

import { json, queryOptionalBool, queryOptionalInt, queryValue } from "../body";
import { invalidArgument, internal } from "../errors";
import type { Router } from "../router";
import { decodePartyCursor } from "../../domain/party/catalog";
import { listPartyRecords } from "../../domain/party/store";
import { partyListBody } from "../../wire/party";

const INVALID_LIMIT = "Invalid limit - limit must be between 1 and 100.";
const LIST_FAILED = "Error listing matches.";

export function registerPartyRoutes(router: Router): void {
  router.handleUser("GET", "/v2/party", async (context) => {
    const { url } = context;

    let limit = 10;
    const rawLimit = queryOptionalInt(url, "limit", INVALID_LIMIT);
    if (rawLimit !== undefined) {
      if (rawLimit < 1 || rawLimit > 100) throw invalidArgument(INVALID_LIMIT);
      limit = rawLimit;
    }

    const open = queryOptionalBool(url, "open");
    // 上游 `in.Query.GetValue()`：包装类型没给 = 空串；空串随后被规整成 `"*"`。
    const given = queryValue(url, "query");
    const query = given === "" ? "*" : given;
    const cursor = queryValue(url, "cursor");

    const page = await (async () => {
      const offset = cursor === "" ? undefined : decodePartyCursor(cursor, { query, open, limit }).offset;
      return await listPartyRecords(context.env.DB, context.tenantEnv.tenantId, {
        limit,
        open,
        query,
        offset,
      });
    })().catch((error: unknown) => {
      console.error("列出派对失败", error);
      throw internal(LIST_FAILED);
    });

    return json(partyListBody(page));
  });
}
