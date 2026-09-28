/**
 * 钱包领域层：批量更新（含账本）与账本读取。
 *
 * `updateWallets` 是上游那个"大事务"的等价物，逐条对齐这四件事：
 *   1. **不存在的用户被跳过**（不是报错）——上游 `wallets[userID]` 查不到就 `continue`；
 *   2. **同一个用户在一批里出现多次会累加**：上游把 `walletMap` 从库里读出来之后
 *      就在内存里一路改下去，所以第二次 update 看到的是第一次的结果；
 *   3. 任一路径算成负数 → 整批不写、抛 `WalletNegativeError`、并把所有结果的
 *      `updated` 清成 `undefined`；
 *   4. `updateLedger` 为真时**每条 update 写一行账本**（同一用户多次就是多行）。
 *
 * 与上游唯一的实现差异是并发控制：上游 `SELECT ... FOR UPDATE`，这里 CAS + 重试
 * （见 store.ts 的说明与 ECN-0010 偏差 5）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_wallet.go::UpdateWallets
 * 契约源: server/core_wallet.go::ListWalletLedger
 */

import {
  buildWalletWriteStatements,
  selectWalletLedger,
  selectWallets,
  updateWalletLedgerRow,
  type LedgerCursor,
  type LedgerWrite,
  type WalletWrite,
} from "./store";
import { WalletNegativeError, parseWallet, type WalletUpdate, type WalletUpdateResult } from "./types";
import { toBase64Url } from "../../base64url";

/** CAS 冲突的重试上限：每次重试都基于新读到的快照重算，越界就是真的写不进去。 */
const MAX_ATTEMPTS = 8;

/**
 * 同租户内的钱包写入串行化。
 *
 * 上游靠 `SELECT ... FOR UPDATE` 让并发写排队；workerd 里同一个 isolate 内的并发请求
 * 共享这一份模块状态，所以先在这里排一道队——冲突就只剩"跨 isolate"这一种，
 * 由 CAS 重试兜住。两道防线合起来，等于上游的"锁 + 事务"。
 */
const writeQueues = new Map<string, Promise<unknown>>();

async function serialize<T>(tenantId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(tenantId) ?? Promise.resolve();
  const current = previous.then(task, task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(tenantId, settled);
  // 队尾兑现且没有后来者时把这一格删掉，免得租户多了以后这张表无限长大。
  void settled.then(() => {
    if (writeQueues.get(tenantId) === settled) writeQueues.delete(tenantId);
  });
  return current;
}

export async function updateWallets(
  db: D1Database,
  tenantId: string,
  now: number,
  updates: readonly WalletUpdate[],
  updateLedger: boolean,
): Promise<WalletUpdateResult[]> {
  if (updates.length === 0) return [];
  return serialize(tenantId, () => updateWalletsUnlocked(db, tenantId, now, updates, updateLedger));
}

async function updateWalletsUnlocked(
  db: D1Database,
  tenantId: string,
  now: number,
  updates: readonly WalletUpdate[],
  updateLedger: boolean,
): Promise<WalletUpdateResult[]> {
  const results = new Map<number, WalletUpdateResult>();
  let pending = updates.map((_update, index) => index);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (pending.length === 0) break;

    const rows = await selectWallets(db, tenantId, pending.map((index) => updates[index]!.userId));
    const stored = new Map(rows.results.map((row) => [row.id, row.wallet]));
    /** 同一批里同一用户共享一份"正在改的钱包"，这就是上游累加语义的来源。 */
    const working = new Map<string, Record<string, number>>();
    const originals = new Map<string, string>();
    const writes = new Map<string, WalletWrite>();
    const ledger: LedgerWrite[] = [];
    const attempted: number[] = [];

    for (const index of pending) {
      const update = updates[index]!;
      const currentText = stored.get(update.userId);
      if (currentText === undefined) continue; // 用户不存在：跳过，连结果都不产生。

      let wallet = working.get(update.userId);
      if (wallet === undefined) {
        wallet = parseWallet(currentText);
        working.set(update.userId, wallet);
        originals.set(update.userId, currentText);
      }
      const previous = { ...wallet };

      for (const [key, delta] of Object.entries(update.changeset)) {
        const current = wallet[key] ?? 0;
        const next = current + delta;
        if (next < 0) {
          for (const result of results.values()) result.updated = undefined;
          throw new WalletNegativeError(update.userId, key, current, delta);
        }
        wallet[key] = next;
      }

      results.set(index, { userId: update.userId, previous, updated: { ...wallet } });
      writes.set(update.userId, {
        userId: update.userId,
        previousJson: originals.get(update.userId) as string,
        nextJson: JSON.stringify(wallet),
      });
      if (updateLedger) {
        ledger.push({
          userId: update.userId,
          changesetJson: JSON.stringify(update.changeset),
          metadata: update.metadata,
        });
      }
      attempted.push(index);
    }

    if (attempted.length === 0) {
      pending = [];
      break;
    }

    try {
      await db.batch(buildWalletWriteStatements(db, tenantId, now, [...writes.values()], ledger));
      pending = [];
    } catch (error) {
      // 原子批次失败 = 这批一条都没落库（守卫语句保证）。重试时只带这批的索引，
      // 于是"上一批已经成功的那部分"不会被重复加钱。
      if (attempt === MAX_ATTEMPTS - 1) throw error;
      pending = attempted;
    }
  }

  const ordered: WalletUpdateResult[] = [];
  for (let index = 0; index < updates.length; index += 1) {
    const result = results.get(index);
    if (result !== undefined) ordered.push(result);
  }
  return ordered;
}

/** 单用户便利入口：上游 `nk.WalletUpdate`。 */
export async function updateWallet(
  db: D1Database,
  tenantId: string,
  now: number,
  userId: string,
  changeset: Readonly<Record<string, number>>,
  metadata: string,
  updateLedger: boolean,
): Promise<WalletUpdateResult | null> {
  const results = await updateWallets(db, tenantId, now, [{ userId, changeset, metadata }], updateLedger);
  return results[0] ?? null;
}

export interface WalletLedgerListResult {
  readonly entries: readonly {
    readonly id: string;
    readonly userId: string;
    readonly changeset: Record<string, number>;
    readonly metadata: Record<string, unknown>;
    readonly createTime: number;
    readonly updateTime: number;
  }[];
  readonly nextCursor: string;
  readonly prevCursor: string;
}

/** 读用户的钱包（`GET /v2/account` 的 `wallet` 字段就是它的 JSON 文本）。 */
export async function readWallet(db: D1Database, tenantId: string, userId: string): Promise<string> {
  const row = await db
    .prepare("SELECT wallet FROM users WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, userId)
    .first<{ wallet: string }>();
  return row?.wallet ?? "{}";
}

export async function listWalletLedger(
  db: D1Database,
  tenantId: string,
  userId: string,
  now: number,
  options: {
    readonly limit: number | null;
    readonly cursor: LedgerCursor | null;
    readonly after: number;
    readonly before: number;
  },
): Promise<WalletLedgerListResult> {
  const rows = await selectWalletLedger(db, tenantId, userId, { ...options, now });
  const limit = options.limit;
  const backwards = options.cursor !== null && !options.cursor.isNext;
  const page = limit !== null && rows.length > limit ? rows.slice(0, limit) : rows;
  const hasMore = limit !== null && rows.length > limit;

  let nextCursor: LedgerCursor | null = null;
  let prevCursor: LedgerCursor | null = null;
  if (options.cursor !== null) {
    // 翻页时的游标：一页两端的记录，方向与请求方向相反。
    const first = page[0];
    const last = page[page.length - 1];
    if (first !== undefined) {
      prevCursor = { userId, createTime: first.create_time, id: first.id, isNext: !backwards };
    }
    if (last !== undefined && hasMore) {
      nextCursor = { userId, createTime: last.create_time, id: last.id, isNext: backwards };
    }
  } else if (page.length > 0 && hasMore) {
    const last = page[page.length - 1] as (typeof page)[number];
    nextCursor = { userId, createTime: last.create_time, id: last.id, isNext: true };
  }

  const ordered = backwards ? [...page].reverse() : page;
  return {
    entries: ordered.map((row) => ({
      id: row.id,
      userId,
      changeset: parseWallet(row.changeset),
      metadata: JSON.parse(row.metadata === "" ? "{}" : row.metadata) as Record<string, unknown>,
      createTime: row.create_time,
      updateTime: row.update_time,
    })),
    nextCursor: nextCursor === null ? "" : encodeLedgerCursor(nextCursor),
    prevCursor: prevCursor === null ? "" : encodeLedgerCursor(prevCursor),
  };
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export async function updateLedgerMetadata(
  db: D1Database,
  tenantId: string,
  ledgerId: string,
  metadata: string,
  now: number,
): Promise<void> {
  await updateWalletLedgerRow(db, tenantId, ledgerId, metadata, now);
}
