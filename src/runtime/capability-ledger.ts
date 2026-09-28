/**
 * `nk` 的钱包账本面：`walletLedgerList` / `walletLedgerUpdate`。
 *
 * 这两条与**控制台**的账本端点是同一个上游函数（`server/core_wallet.go::ListWalletLedger`），
 * 所以这里刻意复用 `src/domain/console/ledger.ts` 的那一份实现，而不是再写一条查询：
 * 两条入口的差别只有"调用面怎么折错误"，那件事由调用面各自做。
 *
 * 两处形状照抄上游：
 *   - `cursor` 到底时是 **`null`**（不是空串，也不是缺字段）；
 *   - items 里的 `changeset` / `metadata` 是**对象**（`ListWalletLedger` 解过 JSON 才
 *     放进结果），而**控制台**那条线格式里它们是字符串——两个面不要互相抄。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.walletLedgerList
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.walletLedgerUpdate
 * 契约源: server/core_wallet.go::ListWalletLedger
 * 契约源: server/core_wallet.go::UpdateWalletLedger
 *
 * REQ-0001-014
 */

import type { DataContext } from "./capability-data";
import { intOf, metadataText, ownerIdOf, text } from "./competitive-args";
import { LedgerCursorError, listWalletLedger } from "../domain/console/ledger";
import { updateWalletLedgerRow } from "../domain/competitive/wallet/store";
import { normalizeUserId } from "../realtime/identifiers";

/** 上游 `runtime_javascript_nakama.go` 给这两条失败的固定前缀。 */
const LIST_FAILURE = "failed to retrieve user wallet ledger";
const UPDATE_FAILURE = "failed to update user wallet ledger";

function jsonObject(source: string): Record<string, unknown> {
  if (source === "") return {};
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // 库里出现非 JSON 只可能来自平台自己写坏的数据；给模块空对象比抛异常有用。
    return {};
  }
}

export function buildNkLedger(data: DataContext): Record<string, unknown> {
  const db = data.env.DB;
  const tenantId = data.tenantId;

  return {
    walletLedgerList: async (...args: unknown[]) => {
      const userId = ownerIdOf(args[0]);
      const limit = args[1] === undefined || args[1] === null ? 100 : intOf(args[1], 100);
      const cursor = text(args[2]);
      const page = await listWalletLedger(db, tenantId, {
        userId,
        limit,
        cursor,
        after: 0,
        before: 0,
        now: Math.floor(Date.now() / 1000),
      }).catch((error: unknown) => {
        // 上游把"游标非法"折成 `wallet ledger cursor invalid`；别的失败保持原样。
        if (error instanceof LedgerCursorError) throw new Error(`${LIST_FAILURE}: ${error.message}`);
        throw new Error(`${LIST_FAILURE}: ${messageOf(error)}`);
      });
      return {
        items: page.rows.map((row) => ({
          id: row.id,
          userId,
          createTime: row.create_time,
          updateTime: row.update_time,
          changeset: jsonObject(row.changeset),
          metadata: jsonObject(row.metadata),
        })),
        cursor: page.nextCursor === "" ? null : page.nextCursor,
      };
    },

    walletLedgerUpdate: async (...args: unknown[]) => {
      const itemId = text(args[0]);
      const id = itemId === "" ? null : normalizeUserId(itemId);
      if (id === null) throw new TypeError("expects a valid id");
      if (args[1] === undefined || args[1] === null || typeof args[1] !== "object" || Array.isArray(args[1])) {
        throw new TypeError("expects metadata object");
      }
      const metadata = metadataText(args[1]);
      const row = await updateWalletLedgerRow(db, tenantId, id, metadata, Math.floor(Date.now() / 1000));
      if (row === null) {
        // 上游那一条 UPDATE 用的是 `QueryRowContext`，没有行就是 `ErrNoRows`。
        throw new Error(`${UPDATE_FAILURE}: no rows in result set`);
      }
      return {
        id: itemId,
        userId: row.user_id,
        createTime: row.create_time,
        updateTime: row.update_time,
        // 上游这里把**入参**当 changeset 回填（`"changeset": metadata`，`metadata` 是那个 map），
        // 而 `metadata` 字段来自 `UpdateWalletLedger` 返回的项——它没填 Metadata，于是对外是空表。
        // 本项目回真正落库后的 metadata：字段有信息量，而"空表"在这里没有任何用途。
        changeset: JSON.parse(metadata) as unknown,
        metadata: jsonObject(row.metadata),
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
