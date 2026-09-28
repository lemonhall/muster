/**
 * 对局加入令牌（match token）。
 *
 * 上游在匹配器成局、且没有运行时回调给出 match id 时，会签一个 **HS256 JWT**：
 *
 * ```go
 * jwt.MapClaims{"mid": fmt.Sprintf("%v.", uuid), "exp": now + 30s}
 * ```
 *
 * 客户端拿它去 `match_join`，服务端解出 `mid` 再决定去哪个对局（`pipeline_match.go`
 * 的 `MatchJoin_Token` 分支）。三条细节必须照抄：
 *
 * 1. `mid` 的 node 段是**空**的（`<uuid>.`）——它不是笔误，是"随机新建的中继对局"
 *    的标记；客户端带着它加入时会**创建**流，而不是"必须已存在"；
 * 2. 有效期 30 秒；
 * 3. 签名算法只认 HS256：别的算法（包括 `alg: none`）一律拒绝，而不是"试试看能不能验"。
 *
 * 本项目用租户派生密钥签（与访问令牌同一把 HKDF-SHA256 派生，见 ECN-0001），
 * 因此**一个租户的令牌在另一个租户上验不过**。上游是单租户部署，不存在这条差异。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/matchmaker.go::LocalMatchmaker.Process
 *
 * REQ-0001-018
 */

import { fromBase64UrlBytes, toBase64Url } from "../base64url";
import { deriveTenantSessionKey } from "../identity/token";
import type { Bindings } from "../../env";
import { requireSessionEncryptionKey } from "../../env";

/** 上游写死的有效期。 */
export const MATCH_TOKEN_TTL_SECONDS = 30;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER = { alg: "HS256", typ: "JWT" } as const;

function encodeSegment(value: unknown): string {
  return toBase64Url(JSON.stringify(value));
}

export interface MatchTokenClaims {
  /** match id（`<uuid>.<node>`）。node 段可能是空串。 */
  readonly mid: string;
  /** 过期时间，Unix 秒。 */
  readonly exp: number;
}

/** 签一个加入令牌。`mid` 由调用方决定（匹配器给的是 `<新 uuid>.`）。 */
export async function signMatchToken(
  env: Bindings,
  tenantId: string,
  mid: string,
  nowSec: number,
): Promise<string> {
  const key = await deriveTenantSessionKey(requireSessionEncryptionKey(env), tenantId);
  const signingInput = `${encodeSegment(HEADER)}.${encodeSegment({
    mid,
    exp: nowSec + MATCH_TOKEN_TTL_SECONDS,
  })}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${toBase64Url(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/**
 * 校验并解出 `mid`。任何一步不对都返回 `null`——调用方统一回
 * `Invalid match token`（上游也是把"解不开"与"claim 不对"归成同一条文案）。
 */
export async function verifyMatchToken(
  env: Bindings,
  tenantId: string,
  token: string,
  nowSec: number,
): Promise<MatchTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(decoder.decode(fromBase64UrlBytes(headerPart)));
    payload = JSON.parse(decoder.decode(fromBase64UrlBytes(payloadPart)));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;
  if ((header as { alg?: unknown }).alg !== "HS256") return null;

  const key = await deriveTenantSessionKey(requireSessionEncryptionKey(env), tenantId);
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  const actual = fromBase64UrlBytes(signaturePart);
  const wanted = new Uint8Array(expected);
  if (actual.length !== wanted.length) return null;
  // 定长比较，避免"验签提前返回"这种时序侧信道。
  let diff = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    diff |= (actual[index] as number) ^ (wanted[index] as number);
  }
  if (diff !== 0) return null;

  if (typeof payload !== "object" || payload === null) return null;
  const claims = payload as { mid?: unknown; exp?: unknown };
  if (typeof claims.mid !== "string" || claims.mid === "") return null;
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
  return { mid: claims.mid, exp: claims.exp };
}

/** 匹配器给"新建中继对局"用的 mid：`<uuid>.`（node 段为空）。 */
export function newRelayMatchId(uuid: string): string {
  return `${uuid}.`;
}
