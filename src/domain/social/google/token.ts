/**
 * `CheckGoogleToken` 的等价物：一串值 → 一个可信的 Google 档案。
 *
 * 判决顺序（每一步都能在上游找到出处，`social/social.go::CheckGoogleToken`）：
 *   1. **形状**：三段式 JWS？解不出来就是"不是 ID token"，此时才考虑授权码流程；
 *   2. **签名**：拿当前证书表逐个试 RS256（上游 keyfunc 不看 kid，逐证书试）；
 *   3. **声明**：`iss` 只认两个值；配了 client id 时校验 `aud` 与（存在时的）`azp`；
 *      `exp` 必填且不能过期；
 *   4. **取值**：把声明映射成档案（`profileFromClaims`）。
 *
 * 第 1 步与第 2/3 步的**分界**是本文件最要紧的地方：一个三段式但验签不过的值，
 * 绝不能掉进授权码流程（否则我们等于把畸形 JWT 当授权码发给 Google）。
 * `isJwtShaped` 就是那条分界线，上游用 `strings.Count(idToken, ".") == 2` 实现同一件事。
 *
 * 没配置任何 client id 时只放行不校验 `aud`/`azp`——这是上游 `NewClient` 的显式选择
 * （它同时打一条 Warn 日志），不是本项目的妥协，见 ECN-0009。
 *
 * 契约源（机器可读）：
 * 契约源: social/social.go::CheckGoogleToken
 * 契约源: social/google_token_audience_test.go::TestCheckGoogleTokenValidatesAudience
 */

import { exchangeAuthorizationCode, type GoogleAuthCodeConfig } from "./auth-code";
import type { GoogleCertSource } from "./certs";
import { GoogleTokenError, isJwtShaped, parseGoogleJwt } from "./jwt";
import { profileFromClaims, type GoogleProfile } from "./profile";
import { verifySignature } from "./verify";

/** 上游接受的 issuer 字面量，两个都要认（Google 老 token 用不带 scheme 的写法）。 */
const GOOGLE_ISSUERS: readonly string[] = ["accounts.google.com", "https://accounts.google.com"];

export interface CheckGoogleTokenInput {
  readonly idToken: string;
  /** 运营者配置的 OAuth client id 集合（对应上游 `googleClientIDs`）。空集 = 跳过 aud/azp 校验。 */
  readonly clientIds: readonly string[];
  readonly certs: GoogleCertSource;
  readonly nowSec: number;
  /** 授权码流程的配置。没配时，非 JWT 形状的输入直接判无效。 */
  readonly authCode?: GoogleAuthCodeConfig | undefined;
}

export async function checkGoogleToken(input: CheckGoogleTokenInput): Promise<GoogleProfile> {
  let parsed;
  try {
    parsed = parseGoogleJwt(input.idToken);
  } catch (error) {
    // 形状不对：可能是授权码。**注意这里只放行"不是三段式"的值**。
    if (isJwtShaped(input.idToken)) throw asTokenError(error);
    if (input.authCode === undefined) {
      throw new GoogleTokenError("google authorization code flow is not configured");
    }
    return exchangeAuthorizationCode(input.authCode, input.idToken);
  }

  // 声明先判、签名后验：两者都是"不通过就一个结局"，但先做本地判断就不会为了一个
  // 明显不合格的 token 去取证书表（一次外部请求）。判决顺序对客户端不可见。
  validateClaims(parsed.claims, input.clientIds, input.nowSec);
  const certs = await input.certs.get();
  if (!(await verifySignature(parsed, certs))) {
    throw new GoogleTokenError("google id token signature did not verify against any certificate");
  }
  return profileFromClaims(parsed.claims);
}

/**
 * 声明校验。顺序照上游：`iss` → `aud` → `azp`（都发生在取公钥那一步），
 * `exp` 最后（库的 `WithExpirationRequired()`）。
 */
export function validateClaims(
  claims: Record<string, unknown>,
  clientIds: readonly string[],
  nowSec: number,
): void {
  const issuer = claims["iss"];
  if (typeof issuer !== "string" || !GOOGLE_ISSUERS.includes(issuer)) {
    throw new GoogleTokenError(`unexpected issuer: ${String(issuer)}`);
  }

  const allowed = allowedClientIds(clientIds);
  if (allowed.size > 0) {
    const audience = claims["aud"];
    if (typeof audience !== "string" || audience === "") {
      throw new GoogleTokenError(`invalid audience claim: ${String(audience)}`);
    }
    if (!allowed.has(audience)) throw new GoogleTokenError(`unexpected audience: ${audience}`);

    const authorizedParty = claims["azp"];
    if (authorizedParty !== undefined) {
      if (typeof authorizedParty !== "string" || authorizedParty === "") {
        throw new GoogleTokenError(`invalid authorized party claim: ${String(authorizedParty)}`);
      }
      if (!allowed.has(authorizedParty)) {
        throw new GoogleTokenError(`unexpected authorized party: ${authorizedParty}`);
      }
    }
  }

  const expiresAt = claims["exp"];
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new GoogleTokenError("token is missing a numeric exp claim");
  }
  if (expiresAt <= nowSec) throw new GoogleTokenError("google id token is expired");
}

/** 上游 `NewClient` 对 client id 的处理：去空白、丢空串。 */
function allowedClientIds(clientIds: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const clientId of clientIds) {
    const trimmed = clientId.trim();
    if (trimmed !== "") allowed.add(trimmed);
  }
  return allowed;
}

function asTokenError(error: unknown): GoogleTokenError {
  return error instanceof GoogleTokenError ? error : new GoogleTokenError(String(error));
}
