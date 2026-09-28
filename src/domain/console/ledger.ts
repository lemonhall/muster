/**
 * 控制台的钱包账本列表：时间窗 + 游标分页。
 *
 * 上游的游标是 gob 编码的 `walletLedgerListCursor{UserId, CreateTime, Id, IsNext,
 * After, Before}`（`server/core_wallet.go`）。本项目换成 `base64url(JSON)`（ECN-0004 的
 * 同一决定），但**带哪些字段、怎么比对**照旧，因为那是"换一批过滤条件就不能再用旧游标"
 * 这条保护的全部内容：用户在界面上把时间窗改了，却还用着上一页的游标，结果是一份
 * 前后不一致的列表——上游选择直接判非法，本项目沿用。
 *
 * 一处**有意的不同**（ECN-0010 偏差 12 的收尾）：上游生成的游标里 `After` / `Before`
 * 是零值，而解码时又要 `after.Equal(cursor.After)`，于是"带时间窗翻页"在上游**必然**
 * 被判非法。本项目把时间窗写进游标，于是同一时间窗翻页可用、换时间窗翻页被判非法。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_wallet.go::ListWalletLedger
 * 契约源: server/console_account.go::GetWalletLedger
 *
 * REQ-0001-021
 */

import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../base64url";
import {
  selectWalletLedger,
  type LedgerCursor,
  type WalletLedgerListRow,
} from "../competitive/wallet/store";

/** 上游控制台端点把这一类错误一律折成 Internal（连同"游标非法"一起）。 */
export const LEDGER_LIST_FAILURE = "An error occurred while trying to list the user's wallet ledger.";

/** 上游 `runtime.ErrWalletLedgerInvalidCursor` 的原文（`runtime/runtime.go`）。 */
export const LEDGER_CURSOR_INVALID = "wallet ledger cursor invalid";

/**
 * "游标非法"这一个领域失败。
 *
 * 两个调用面的**折法不同**，所以领域层只报"是哪一种失败"，由调用面各自翻译：
 *   - 控制台端点（`server/console_account.go::GetWalletLedger`）把它连同别的错误
 *     一起折成 `Internal` + `LEDGER_LIST_FAILURE`；
 *   - 运行时 `nk.walletLedgerList` 折成
 *     `failed to retrieve user wallet ledger: wallet ledger cursor invalid`。
 * 把 HTTP 状态码写进领域层，运行时那一侧就只能去反解一个 HTTP 概念。
 */
export class LedgerCursorError extends Error {
  constructor() {
    super(LEDGER_CURSOR_INVALID);
    this.name = "LedgerCursorError";
  }
}

interface StoredCursor {
  readonly userId: string;
  readonly createTime: number;
  readonly id: string;
  readonly isNext: boolean;
  readonly after: number;
  readonly before: number;
}

export interface LedgerQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursor: string;
  readonly after: number;
  readonly before: number;
  readonly now: number;
}

export interface LedgerPage {
  readonly rows: readonly WalletLedgerListRow[];
  readonly nextCursor: string;
  readonly prevCursor: string;
}

function encodeCursor(cursor: StoredCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/**
 * 解码并校验游标。三种情况都判非法（与上游一致）：解不出来、字段类型不对、
 * **与本次请求的用户或时间窗不匹配**。
 */
export function decodeLedgerCursor(raw: string, query: LedgerQuery): LedgerCursor | null {
  if (raw === "") return null;
  if (raw.length > MAX_CURSOR_LENGTH) throw new LedgerCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw new LedgerCursorError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LedgerCursorError();
  }
  const record = parsed as Record<string, unknown>;
  const { userId, createTime, id, isNext, after, before } = record;
  if (
    typeof userId !== "string" ||
    typeof id !== "string" ||
    typeof isNext !== "boolean" ||
    typeof createTime !== "number" ||
    typeof after !== "number" ||
    typeof before !== "number" ||
    !Number.isInteger(createTime)
  ) {
    throw new LedgerCursorError();
  }
  if (userId !== query.userId || after !== query.after || before !== query.before) {
    throw new LedgerCursorError();
  }
  return { userId, createTime, id, isNext };
}

/**
 * 上游那段"翻页为什么有两个游标"的等价重写：
 *   - 往下翻（`isNext`）：多取一行当 `next` 的锚；
 *   - 往上翻（`!isNext`）：查询方向相反，取完要**反转**，两个游标的角色互换。
 * 逐行照抄是因为"少取一行"或"忘了反转"都会让翻页**漏掉边界那一条**。
 */
function nextCursorOf(query: LedgerQuery, row: WalletLedgerListRow, isNext: boolean): StoredCursor {
  return {
    userId: query.userId,
    createTime: row.create_time,
    id: row.id,
    isNext,
    after: query.after,
    before: query.before,
  };
}

export async function listWalletLedger(
  db: D1Database,
  tenantId: string,
  query: LedgerQuery,
): Promise<LedgerPage> {
  const incoming = decodeLedgerCursor(query.cursor, query);
  const rows = await selectWalletLedger(db, tenantId, query.userId, {
    limit: query.limit,
    cursor: incoming,
    after: query.after,
    before: query.before,
    now: query.now,
  });

  const overflowed = rows.length > query.limit;
  const page = overflowed ? rows.slice(0, query.limit) : [...rows];
  // 游标锚在**最后一行的那个位置**（上游是在循环顶部用"上一行"的 id/createTime 造它），
  // 不是锚在多取出来的那一行上——锚错一行，翻页就会漏掉边界那一条。
  const last = page[page.length - 1];
  const first = page[0];
  let nextCursor: StoredCursor | null =
    overflowed && last !== undefined ? nextCursorOf(query, last, true) : null;
  let prevCursor: StoredCursor | null =
    incoming !== null && first !== undefined ? nextCursorOf(query, first, false) : null;

  if (incoming !== null && !incoming.isNext) {
    if (nextCursor !== null && prevCursor !== null) {
      const swapped = nextCursor;
      nextCursor = prevCursor;
      prevCursor = swapped;
    } else if (nextCursor !== null) {
      prevCursor = { ...nextCursor, isNext: !nextCursor.isNext };
      nextCursor = null;
    } else if (prevCursor !== null) {
      nextCursor = { ...prevCursor, isNext: !prevCursor.isNext };
      prevCursor = null;
    }
    page.reverse();
  }

  return {
    rows: page,
    nextCursor: nextCursor === null ? "" : encodeCursor(nextCursor),
    prevCursor: prevCursor === null ? "" : encodeCursor(prevCursor),
  };
}
