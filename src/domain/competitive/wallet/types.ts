/**
 * 钱包与账本的类型。
 *
 * 上游的钱包是 `users.wallet` 上的一个 jsonb 对象，值是 int64；"加钱"是
 * `wallet[k] += delta`。本项目把同一份 JSON 存成 TEXT，数值仍用 JS number——
 * 超过 2^53 的钱包在两边都会失真，这是上游 int64 与本项目 number 的共同边界，
 * 登记在 ECN-0010 偏差 7。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_wallet.go::UpdateWallets
 * 契约源: server/core_wallet.go::updateWallets
 */

export interface WalletUpdate {
  readonly userId: string;
  readonly changeset: Readonly<Record<string, number>>;
  /** 上游约定这里已经是合法 JSON 文本；空串在库里落成 `{}`。 */
  readonly metadata: string;
}

export interface WalletUpdateResult {
  readonly userId: string;
  readonly previous: Readonly<Record<string, number>>;
  /**
   * 更新后的钱包。**回滚时是 `undefined`**：上游在事务失败后把每条结果的
   * `Updated` 清成 nil，因为它没有落库，报出去就是撒谎。
   */
  updated: Record<string, number> | undefined;
}

/** 余额会变成负数。上游用这个类型区分"业务失败"与"系统失败"（前者不进错误日志）。 */
export class WalletNegativeError extends Error {
  readonly userId: string;
  readonly path: string;
  readonly current: number;
  readonly amount: number;

  constructor(userId: string, path: string, current: number, amount: number) {
    super(`Wallet ${path} would become negative for user ${userId}.`);
    this.name = "WalletNegativeError";
    this.userId = userId;
    this.path = path;
    this.current = current;
    this.amount = amount;
  }
}

export interface WalletLedgerRow {
  readonly id: string;
  readonly user_id: string;
  readonly changeset: string;
  readonly metadata: string;
  readonly create_time: number;
  readonly update_time: number;
}

export function parseWallet(text: string): Record<string, number> {
  const parsed: unknown = JSON.parse(text === "" ? "{}" : text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Wallet value is not a JSON object: ${text}`);
  }
  const wallet: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    wallet[key] = typeof value === "number" ? value : Number(value);
  }
  return wallet;
}
