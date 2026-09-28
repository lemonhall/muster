/**
 * Google 登录的运营者配置 → 领域层依赖。
 *
 * 四个绑定都是**可选**的，缺省时的行为必须可预测（这也是配置检查清单）：
 *   - `GOOGLE_CLIENT_IDS`（逗号分隔）：空集 = 不校验 `aud`/`azp`，照上游只打警告放行；
 *   - `GOOGLE_CLIENT_SECRET` + `GOOGLE_TOKEN_ENDPOINT`：两个都在才启用授权码流程，
 *     否则"非 JWT 形状的输入"直接判无效（上游缺 `oauth2.Config` 时同样是失败）；
 *   - `GOOGLE_JWKS_URL`：默认走 Google 的 `/oauth2/v3/certs`，可指向自建代理。
 *
 * 证书表的缓存是**按 URL** 建的模块级单例：同一个 Worker 实例内多次登录共用一份公钥，
 * 换 URL 就是换一份缓存（ECN-0009）。缓存对象自己管 TTL 与"刷新失败保留旧值"。
 */

import type { Bindings } from "../../../env";
import type { GoogleAuthCodeConfig } from "./auth-code";
import { createJwksCertSource, GOOGLE_JWKS_URL, type GoogleCertSource } from "./certs";
import type { GoogleDeps } from "./authenticate";

const certSources = new Map<string, GoogleCertSource>();

/** 按 URL 复用证书源；`fetch` 用延迟查表，测试替换全局 fetch 时同样生效。 */
export function certSourceFor(url: string): GoogleCertSource {
  const existing = certSources.get(url);
  if (existing !== undefined) return existing;
  const created = createJwksCertSource({ fetch: (input, init) => fetch(input, init), url });
  certSources.set(url, created);
  return created;
}

export function googleDepsOf(env: Bindings): GoogleDeps {
  const clientIds = splitList(env.GOOGLE_CLIENT_IDS);
  const deps: GoogleDeps = {
    clientIds,
    certs: certSourceFor(blankToUndefined(env.GOOGLE_JWKS_URL) ?? GOOGLE_JWKS_URL),
  };

  const secret = blankToUndefined(env.GOOGLE_CLIENT_SECRET);
  const tokenEndpoint = blankToUndefined(env.GOOGLE_TOKEN_ENDPOINT);
  const firstClientId = clientIds[0];
  // 授权码流程要一个 client id 去换 token：上游用的是 `oauth2.Config.ClientID`（单个），
  // 这里取列表里的第一个，并把它写进注释而不是靠"列表顺序"这个隐含约定。
  if (secret === undefined || tokenEndpoint === undefined || firstClientId === undefined) return deps;

  const authCode: GoogleAuthCodeConfig = {
    clientId: firstClientId,
    clientSecret: secret,
    tokenEndpoint,
    fetch: (input, init) => fetch(input, init),
  };
  return { ...deps, authCode };
}

/** 上游 `NewClient`：去空白、丢空串。 */
function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function blankToUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}
