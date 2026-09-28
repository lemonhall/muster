/**
 * Google ID token 的**结构**解析（不验签）。
 *
 * 这一层只回答"这串东西是不是一个三段式 JWS、它的 header 里写的是什么算法"，
 * 任何与签发者有关的判断都在 `token.ts`。分开的理由是上游那段逻辑的形状：
 * `strings.Count(idToken, ".") == 2` 是"该不该走授权码流程"的硬闸门，
 * 而它**只看形状**——形状判断必须先于、独立于签名验证发生。
 *
 * 上游用 `golang-jwt/jwt/v5` 的 `jwt.Parse`；这里手写三段式解析。手写的理由是
 * Workers 上没有一个等价的库，而这段逻辑短到可以逐行审阅：拆段、解 base64url、
 * 认 `alg`、把 payload 当对象。凡是解析不出来的都抛 `GoogleTokenError`，
 * 对外只有一句话（`google id token invalid`），细节留给日志。
 *
 * 契约源（机器可读）：
 * 契约源: social/social.go::CheckGoogleToken
 * 契约源: social/google_token_audience_test.go::TestCheckGoogleTokenDoesNotExchangeMalformedJWT
 */

import { fromBase64Url, fromBase64UrlBytes } from "../../base64url";

/** 内部错误：`reason` 只进日志，对外一律折叠成 `google id token invalid`。 */
export class GoogleTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GoogleTokenError";
  }
}

export interface GoogleJwtHeader {
  /** 上游用 `jwt.WithValidMethods([]string{"RS256"})` 钉死；非 RS256 一律拒。 */
  readonly alg: string;
  /** JWKS 的键 id。上游**不**按 kid 挑证书（拿每个证书都试一遍），这里同样只记录它。 */
  readonly kid: string | null;
}

export interface ParsedGoogleJwt {
  readonly header: GoogleJwtHeader;
  readonly claims: Record<string, unknown>;
  /** `header.payload`：验签要签的就是这一段原始文本，不能重新序列化。 */
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

/** 三段式形状判断（上游那句 `strings.Count(idToken, ".") == 2`）。 */
export function isJwtShaped(raw: string): boolean {
  return raw.split(".").length === 3;
}

export function parseGoogleJwt(raw: string): ParsedGoogleJwt {
  const segments = raw.split(".");
  if (segments.length !== 3) throw new GoogleTokenError("token is not a three-segment JWT");
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  if (encodedHeader === "" || encodedPayload === "") {
    throw new GoogleTokenError("token has an empty header or payload segment");
  }

  const header = decodeJsonObject(encodedHeader, "header");
  const claims = decodeJsonObject(encodedPayload, "payload");

  const alg = header["alg"];
  if (alg !== "RS256") throw new GoogleTokenError(`unexpected signing algorithm: ${String(alg)}`);
  const kid = header["kid"];
  if (kid !== undefined && typeof kid !== "string") {
    throw new GoogleTokenError("token header has a non-string kid");
  }

  return {
    header: { alg, kid: kid ?? null },
    claims,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: fromBase64UrlBytes(encodedSignature),
  };
}

function decodeJsonObject(segment: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(segment));
  } catch {
    throw new GoogleTokenError(`token ${label} is not base64url encoded JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GoogleTokenError(`token ${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
