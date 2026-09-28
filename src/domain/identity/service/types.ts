/**
 * 身份/会话/账号领域层的类型与默认值。
 *
 * `TenantEnv` 是这一层的形状：**每个入口都必须携带 tenantId**，多租户不是可选参数
 * （ECN-0001）。
 */

import type * as store from "../store";
import type { SessionClaims } from "../token";

export interface TenantEnv {
  readonly db: D1Database;
  readonly masterSecret: string;
  readonly tenantId: string;
  readonly nowSec: number;
  readonly tokenExpirySec: number;
  readonly refreshTokenExpirySec: number;
}

/** 上游默认：`session.token_expiry_sec = 7200`、`refresh_token_expiry_sec = 604800`。 */
export const DEFAULT_TOKEN_EXPIRY_SEC = 7200;
export const DEFAULT_REFRESH_TOKEN_EXPIRY_SEC = 604800;

export interface IdentityResult {
  readonly userId: string;
  readonly username: string;
  readonly created: boolean;
}

export interface SessionResult {
  readonly created: boolean;
  readonly token: string;
  readonly refreshToken: string;
}

export interface AuthenticateInput {
  readonly id: string;
  readonly vars?: Record<string, string>;
  readonly create: boolean;
  readonly username?: string;
}

export interface EmailInput {
  readonly email: string;
  readonly password: string;
  readonly vars?: Record<string, string>;
  readonly create: boolean;
  readonly username?: string;
  /** body 里 `account` 字段整体缺失时上游报的错与"邮箱为空"完全不同，所以要能区分。 */
  readonly accountMissing?: boolean;
}

export interface ResolvedSession {
  readonly claims: SessionClaims;
  readonly user: store.UserRow;
}
