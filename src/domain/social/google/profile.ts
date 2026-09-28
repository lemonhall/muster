/**
 * Google 档案：从校验过的 ID token 声明（或 Play Games 的 access token 响应）里取值。
 *
 * 字段名与上游 `social.GoogleProfile` 的两套实现逐条对齐（`social/social.go`）：
 *   - `JWTGoogleProfile`（ID token）：`iss` / `sub` / `azp` / `aud` / `iat` / `exp`，
 *     以及申请了 profile+email scope 才有的 `email` / `email_verified` / `name` /
 *     `picture` / `given_name` / `family_name` / `locale`；`googleId` = `sub`。
 *   - `GooglePlayServiceProfile`（授权码 + access token）：`playerId` / `displayName` /
 *     `avatarImageUrl` / `originalPlayerId`；`googleId` = `playerId`。
 *
 * 别被"这只是取值"骗了：取出 `googleId` 就是账号身份本身，所以这里的每个类型判断
 * 都按上游抛错，不做"尽量转成字符串"的容错——容错会把一个畸形 token 变成一个账号。
 *
 * 契约源（机器可读）：
 * 契约源: social/social.go::JWTGoogleProfile
 * 契约源: social/social.go::GooglePlayServiceProfile
 */

import { GoogleTokenError } from "./jwt";

export interface GoogleProfile {
  /** 账号身份：ID token 的 `sub`，或 Play Games 的 `playerId`。 */
  readonly googleId: string;
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly azp: string;
  readonly iat: number;
  readonly exp: number;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly picture: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly locale: string;
}

/** 上游 `checkGoogleToken` 里那段"逐个字段取出来"的等价物（在验证通过之后调用）。 */
export function profileFromClaims(claims: Record<string, unknown>): GoogleProfile {
  return {
    googleId: requiredString(claims, "sub"),
    iss: requiredString(claims, "iss"),
    sub: requiredString(claims, "sub"),
    aud: requiredString(claims, "aud"),
    azp: optionalString(claims["azp"]),
    iat: optionalNumericDate(claims["iat"]),
    exp: optionalNumericDate(claims["exp"]),
    email: optionalString(claims["email"]),
    emailVerified: claims["email_verified"] === true,
    name: optionalString(claims["name"]),
    picture: optionalString(claims["picture"]),
    givenName: optionalString(claims["given_name"]),
    familyName: optionalString(claims["family_name"]),
    locale: optionalString(claims["locale"]),
  };
}

/** Play Games 的 `/games/v1/players/me` 响应 → 档案。字段名就是线上的 camelCase。 */
export function playGamesProfile(body: unknown): GoogleProfile {
  const record = (body ?? {}) as Record<string, unknown>;
  const playerId = optionalString(record["playerId"]);
  // 上游把这一条单独报出来（`player_id cannot be an empty string.`）。
  if (playerId === "") throw new GoogleTokenError("player_id cannot be an empty string");
  return {
    googleId: playerId,
    iss: "",
    sub: playerId,
    aud: "",
    azp: "",
    iat: 0,
    exp: 0,
    email: "",
    emailVerified: false,
    name: optionalString(record["displayName"]),
    picture: optionalString(record["avatarImageUrl"]),
    givenName: "",
    familyName: "",
    locale: "",
  };
}

function requiredString(container: Record<string, unknown>, key: string): string {
  const value = container[key];
  if (typeof value !== "string") throw new GoogleTokenError(`google id token ${key} field invalid`);
  return value;
}

function optionalString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new GoogleTokenError("google id token field invalid");
  return value;
}

/**
 * 数值日期：上游接受 `float64` / `int64` / 数字字符串三种（`strconv.Atoi` 那条分支）。
 * 缺失按 0 处理（上游只对 `exp` 强制要求存在，而那条约束在验签阶段已经判过）。
 */
function optionalNumericDate(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new GoogleTokenError("google id token numeric date field invalid");
}
