import type { Bindings } from "../env";
import { requireSessionEncryptionKey } from "../env";
import type { ResolvedSession, TenantEnv } from "../domain/identity/service";
import {
  DEFAULT_REFRESH_TOKEN_EXPIRY_SEC,
  DEFAULT_TOKEN_EXPIRY_SEC,
  resolveBearerSession,
} from "../domain/identity/service";
import { peekTenantId } from "../domain/identity/token";
import { findTenantById, findTenantByServerKey, type TenantRow } from "../domain/tenancy/store";
import { unauthenticated } from "./errors";

/**
 * 鉴权解析层：把 HTTP 头翻译成"这是哪个租户 + 是谁"。
 *
 * 本文件的每一条失败消息都逐字抄自上游 `securityInterceptorFunc`
 * （`server/api.go`）——客户端 SDK 会按这些字符串与状态码做分支判断：
 *
 * - 认证类端点（Basic）缺头 → `Server key required`；头坏或键不对 → `Server key invalid`
 * - 其余端点（Bearer）缺头 → `Auth token required`；头坏或令牌不过 → `Auth token invalid`
 *
 * 多租户（ECN-0001）把"租户从哪来"分成两条路，**这是本项目在协议之外自带的能力**：
 * - server key 路：`sha256(key)` 反查 `tenants` 表 → 租户 id；
 * - 用户令牌路：令牌里的 `gid` claim → 租户 id → 用该租户的派生密钥验签。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::securityInterceptorFunc
 * 契约源: server/api.go::parseBasicAuth
 * 契约源: server/api.go::parseBearerAuth
 */

const BASIC_PREFIX = "Basic ";
const BEARER_PREFIX = "Bearer ";

/**
 * 上游 `parseBasicAuth` 的等价物：只认**大小写敏感**的 `Basic ` 前缀，
 * 标准 base64 解码后按第一个 `:` 切开；返回冒号前的部分（即 server key）。
 */
export function parseBasicAuth(header: string): string | null {
  if (!header.startsWith(BASIC_PREFIX)) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice(BASIC_PREFIX.length));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return decoded.slice(0, separator);
}

/** 上游 `parseBearerAuth` 的等价物：只认大小写敏感的 `Bearer ` 前缀。 */
export function parseBearerAuth(header: string): string | null {
  if (!header.startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length);
}

/**
 * 组装领域层要的租户上下文。
 *
 * 过期时间取上游默认值（`session.token_expiry_sec = 7200`、
 * `refresh_token_expiry_sec = 604800`）。把这两个值放进 `TenantEnv` 而不是散落成
 * 常量，是为了让"每个租户可覆盖"这件事将来只需要改这一个函数。
 */
export function tenantEnvOf(env: Bindings, tenantId: string, nowSec: number): TenantEnv {
  return {
    db: env.DB,
    masterSecret: requireSessionEncryptionKey(env),
    tenantId,
    nowSec,
    tokenExpirySec: DEFAULT_TOKEN_EXPIRY_SEC,
    refreshTokenExpirySec: DEFAULT_REFRESH_TOKEN_EXPIRY_SEC,
  };
}

/** 当前 Unix 秒。集中在一处，方便将来换成可注入的时钟。 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 认证类端点：从 `Authorization: Basic base64(<server_key>:)` 解析出租户。
 *
 * 头缺失与头不对给的是**两条不同的消息**——这不是笔误，是上游的行为，
 * 客户端靠它区分"我没配 server key"和"我配错了"。
 */
export async function resolveServerKeyTenant(env: Bindings, request: Request): Promise<TenantEnv> {
  const header = request.headers.get("authorization");
  if (header === null || header === "") throw unauthenticated("Server key required");

  const serverKey = parseBasicAuth(header);
  if (serverKey === null) throw unauthenticated("Server key invalid");

  const tenant = await findTenantByServerKey(env.DB, serverKey);
  if (tenant === null) throw unauthenticated("Server key invalid");

  return tenantEnvOf(env, tenant.id, nowSeconds());
}

export interface BearerContext {
  readonly tenantEnv: TenantEnv;
  readonly session: ResolvedSession;
}

/**
 * 已认证端点：从 Bearer 令牌解析出租户与会话。
 *
 * 顺序是刻意的：先**不验签**读出 `gid`（要验签得先知道用哪把钥匙），
 * 再用该租户的派生密钥做真正的校验。攻击者伪造 `gid` 只会让验签用错钥匙而必然失败，
 * 所以 `peekTenantId` 的返回值只用来选钥匙，绝不当身份事实用。
 *
 * 租户不存在或已禁用 → 与"令牌无效"同一个 401，不向客户端泄露租户登记信息。
 */
export async function resolveBearerContext(env: Bindings, request: Request): Promise<BearerContext> {
  const header = request.headers.get("authorization");
  if (header === null || header === "") throw unauthenticated("Auth token required");

  const token = parseBearerAuth(header);
  if (token === null) throw unauthenticated("Auth token invalid");

  const tenantId = peekTenantId(token);
  if (tenantId === null) throw unauthenticated("Auth token invalid");

  const tenant: TenantRow | null = await findTenantById(env.DB, tenantId);
  if (tenant === null) throw unauthenticated("Auth token invalid");

  const tenantEnv = tenantEnvOf(env, tenant.id, nowSeconds());
  const session = await resolveBearerSession(tenantEnv, token);
  return { tenantEnv, session };
}
