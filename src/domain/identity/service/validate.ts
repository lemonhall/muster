/**
 * 输入校验与状态守卫。
 *
 * 三条正则是上游 `api_authenticate.go` 顶部那三个的等价物；每一句错误消息都照抄，
 * 因为客户端与 SDK 会按字符串做分支。
 */

import { invalidArgument, permissionDenied } from "../../../http/errors";
import type * as store from "../store";

// 上游 api_authenticate.go 顶部三个正则的等价物。
const INVALID_CHARS = /[\u0000-\u001f\u007f\s]/u;
const INVALID_USERNAME_CHARS = /[\u0000-\u001f\u007f]/u;
const EMAIL_FORMAT = /^.+@.+\..+$/u;

const encoder = new TextEncoder();
export const byteLength = (value: string): number => encoder.encode(value).length;

export function usesInvalidChars(value: string): boolean {
  return INVALID_CHARS.test(value);
}

export function usesInvalidUsernameChars(value: string): boolean {
  return INVALID_USERNAME_CHARS.test(value);
}

export function looksLikeEmail(value: string): boolean {
  return EMAIL_FORMAT.test(value);
}

function generateUsername(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length] ?? "a").join("");
}

export function validateUsername(username: string): string {
  if (username === "") return generateUsername();
  if (usesInvalidUsernameChars(username)) {
    throw invalidArgument("Username invalid, no spaces or control characters allowed.");
  }
  if (byteLength(username) > 128) {
    throw invalidArgument("Username invalid, must be 1-128 bytes.");
  }
  return username;
}

export function validateProviderId(id: string, label: string, minBytes: number): void {
  if (id === "") throw invalidArgument(`${label} ID is required.`);
  if (usesInvalidChars(id)) {
    throw invalidArgument(`${label} ID invalid, no spaces or control characters allowed.`);
  }
  const length = byteLength(id);
  if (length < minBytes || length > 128) {
    throw invalidArgument(`${label} ID invalid, must be ${minBytes}-128 bytes.`);
  }
}

/** 已有账号解禁检查；上游对禁用账号返回 `403 User account banned.`。 */
export function assertNotDisabled(user: store.UserRow): void {
  if (user.disable_time !== 0) {
    throw permissionDenied("User account banned.");
  }
}

/** D1 的唯一约束冲突探测：判断"撞的是哪一列"，从而映射成上游那几条具体错误。 */
export function isUniqueViolation(error: unknown, columnHint: string): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    error.message.includes(columnHint)
  );
}
