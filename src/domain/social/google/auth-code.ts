/**
 * Google 授权码流程（ID token 那条路的兜底）。
 *
 * 上游是 `oauth2.Config.Exchange(ctx, code)` 再
 * `GET https://www.googleapis.com/games/v1/players/me?access_token=…`，两步都用同一个
 * `http.Client`。这里同样两步，请求形状按 OAuth2 的 authorization_code 授权类型拼：
 * `grant_type` / `code` / `client_id` / `client_secret` 走 form 编码。
 *
 * **这一步只在"值不是三段式 JWT"时才会发生**（`token.ts` 的闸门），
 * 否则一个畸形 JWT 会被当成授权码送到 Google——那既是无效请求，也是一条不该有的外部流量。
 *
 * 契约源（机器可读）：
 * 契约源: social/social.go::exchangeGoogleAuthCode
 * 契约源: social/social.go::CheckGoogleToken
 * 契约源: social/google_token_audience_test.go::TestCheckGoogleTokenPreservesAuthorizationCodeFlow
 */

import { GoogleTokenError } from "./jwt";
import { playGamesProfile, type GoogleProfile } from "./profile";
import type { FetchLike } from "./certs";

/** 上游 `/games/v1/players/me` 的地址。运营者可以覆盖（自建代理或地区端点）。 */
export const GOOGLE_PLAYERS_ME_URL = "https://www.googleapis.com/games/v1/players/me";

export interface GoogleAuthCodeConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenEndpoint: string;
  readonly profileEndpoint?: string;
  readonly fetch: FetchLike;
}

export async function exchangeAuthorizationCode(
  config: GoogleAuthCodeConfig,
  code: string,
): Promise<GoogleProfile> {
  const accessToken = await exchangeForAccessToken(config, code);
  const endpoint = config.profileEndpoint ?? GOOGLE_PLAYERS_ME_URL;
  const response = await config.fetch(`${endpoint}?access_token=${encodeURIComponent(accessToken)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new GoogleTokenError(`google player profile endpoint returned ${response.status}`);
  return playGamesProfile(await readJson(response));
}

/** 上游 `exchangeGoogleAuthCode`：换不到 token 就是一个"不是这个 code"的错误。 */
async function exchangeForAccessToken(config: GoogleAuthCodeConfig, code: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const response = await config.fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  if (!response.ok) throw new GoogleTokenError(`google token endpoint returned ${response.status}`);

  const body = (await readJson(response)) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new GoogleTokenError("google token endpoint returned no access token");
  }
  return body.access_token;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GoogleTokenError("google endpoint returned a non-JSON body");
  }
}
