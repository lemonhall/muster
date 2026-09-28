/**
 * 控制台的钱包账本端点：
 *
 *   GET /v2/console/account/{id}/wallet-ledger   列某个账号的账本（可带时间窗与游标）
 *
 * 上游路径是 `/v2/console/account/{account_id}/wallet`；v4 计划冻结的 DoD 措辞是
 * `.../wallet-ledger`。两条都注册，处理器同一份——路径名只影响"客户端要改成哪个"，
 * 不影响语义。
 *
 * 校验顺序照抄上游 `server/console_account.go::GetWalletLedger`：
 *   1. user id 合法性 → `Requires a valid user ID.`
 *   2. `limit` 必须在 1..100 → `expects a limit value between 1 and 100`
 *   3. `after` / `before` 时间窗
 *   4. 列表本身（游标非法也算这一步的失败）
 * 前两条是**各自独立**的校验：上游那句 `expects a limit value between 1 and 100`
 * 没有大写首字母也没有句点，是它的原样，不要"顺手修好"。
 *
 * 鉴权用 tenant server key（ECN-0014 偏差 1）。
 *
 * 契约源（机器可读）：
 * 契约源: server/console_account.go::GetWalletLedger
 * 契约源: console/console.proto::Console/GetWalletLedger
 *
 * REQ-0001-021
 */

import { LEDGER_LIST_FAILURE, LedgerCursorError, listWalletLedger } from "../../domain/console/ledger";
import { walletLedgerListBody } from "../../wire/console";
import { normalizeUserId } from "../../realtime/identifiers";
import { json, queryOptionalInt, queryValue } from "../body";
import { internal, invalidArgument } from "../errors";
import type { AuthedContext, Router } from "../router";

export const LEDGER_LIMIT_RANGE = "expects a limit value between 1 and 100";
export const INVALID_ACCOUNT_ID = "Requires a valid user ID.";
const INVALID_AFTER = "Invalid after: expected an RFC3339 timestamp.";
const INVALID_BEFORE = "Invalid before: expected an RFC3339 timestamp.";

/** 上游的 `after` / `before` 是 `google.protobuf.Timestamp`，query 里是 RFC3339 文本。 */
function timestampSeconds(raw: string, message: string): number {
  if (raw === "") return 0;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw invalidArgument(message);
  return Math.floor(parsed / 1000);
}

async function walletLedger(context: AuthedContext): Promise<Response> {
  const rawId = context.params.id ?? context.params.account_id ?? "";
  const userId = normalizeUserId(rawId);
  if (userId === null) throw invalidArgument(INVALID_ACCOUNT_ID);

  const limit = queryOptionalInt(context.url, "limit", LEDGER_LIMIT_RANGE);
  if (limit === undefined || limit < 1 || limit > 100) throw invalidArgument(LEDGER_LIMIT_RANGE);

  const after = timestampSeconds(queryValue(context.url, "after"), INVALID_AFTER);
  const before = timestampSeconds(queryValue(context.url, "before"), INVALID_BEFORE);

  // 上游这一条端点的失败路径只有一句话：游标非法连同别的错误整段折成 Internal。
  const page = await listWalletLedger(context.env.DB, context.tenantEnv.tenantId, {
      userId,
      limit,
      cursor: queryValue(context.url, "cursor"),
      after,
      before,
      now: context.tenantEnv.nowSec,
    }).catch((error: unknown) => {
      if (error instanceof LedgerCursorError) throw internal(LEDGER_LIST_FAILURE);
      throw error;
    });
  return json(
    walletLedgerListBody(page.rows, userId, page.nextCursor, page.prevCursor),
  );
}

export function registerConsoleLedgerRoutes(router: Router): void {
  router.handleServerKey("GET", "/v2/console/account/{id}/wallet-ledger", walletLedger);
  router.handleServerKey("GET", "/v2/console/account/{account_id}/wallet", walletLedger);
}
