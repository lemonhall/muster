import type { Channel } from "./durable/channel";
import type { Match } from "./durable/match";
import type { Matchmaker } from "./durable/matchmaker";
import type { SessionRegistry } from "./durable/session-registry";
import type { SessionShard } from "./durable/session-shard";

/**
 * 本 Worker 的绑定类型。
 *
 * 绑定按里程碑逐个引入，不提前占位：
 * - M1：`DB`（D1Database，租户/用户/身份/会话的权威库）、`SESSION_ENCRYPTION_KEY`（secret）
 * - M3：`SESSION_SHARD`（DurableObjectNamespace，会话分片）、`SESSION_REGISTRY`
 * - M4：`CHANNEL`（DurableObjectNamespace，每频道一个实例）
 * - M7：`MATCHMAKER`（每租户一个匹配池）、`MATCH`（每场对局一个实例）
 *
 * 全局 `Env` 接口由 `wrangler types` 生成到 `worker-configuration.d.ts`（配置里声明的绑定），
 * 而 **secret 不在配置里**，所以在这里显式补上。
 */
export interface Bindings extends Env {
  /**
   * 令牌签名主密钥。每个租户的签名密钥由它 + 租户 id 派生（HKDF-SHA256）。
   *
   * 仓库里不存真密钥：本地开发用 `.dev.vars`，线上用 `wrangler secret put`，
   * 测试由 vitest 池注入固定值。缺失时认证端点会明确报 500，而不是退回一个弱默认值。
   */
  SESSION_ENCRYPTION_KEY: string;

  /**
   * M3：一条 WebSocket 一个的会话分片 + 每租户一个的会话注册表。
   * 都是 Durable Object，本地开发与测试跑在 workerd 内，不连线上资源。
   */
  SESSION_SHARD: DurableObjectNamespace<SessionShard>;
  SESSION_REGISTRY: DurableObjectNamespace<SessionRegistry>;

  /**
   * M4：一个频道一个实例。键是 `租户|频道 id`（`channelKeyOf`），成员表、presence
   * 与持久化消息历史都住在这个 DO 里（单点定序）。
   */
  CHANNEL: DurableObjectNamespace<Channel>;

  /**
   * M7：一个租户一个匹配池（成局必须有一个单点看整个池子），一场对局一个实例
   * （成员快照与广播顺序要靠单点定序）。都是 SQLite 后端，本地跑在 workerd 里。
   */
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  MATCH: DurableObjectNamespace<Match>;

  /**
   * M5：Google 登录。四个都是**可选**的，缺省行为在 `src/domain/social/google/config.ts`
   * 里写死成一张清单（空 client id = 不校验 aud/azp；没有 secret+endpoint = 不启用授权码流程）。
   *
   * 与 `SESSION_ENCRYPTION_KEY` 同类：不进 `wrangler.jsonc` 的公开 vars，
   * 本地用 `.dev.vars`、线上用 `wrangler secret put`。
   */
  GOOGLE_CLIENT_IDS?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_TOKEN_ENDPOINT?: string;
  GOOGLE_JWKS_URL?: string;
}

/**
 * 取主密钥；没配就抛错。
 *
 * 这条守卫是**故意的**：多租户下所有令牌的可信度都建立在这一个密钥上，
 * 一个"默认空串"会让所有租户的令牌都能被伪造。宁可 500，也不静默降级。
 */
export function requireSessionEncryptionKey(env: Bindings): string {
  const key = env.SESSION_ENCRYPTION_KEY;
  if (typeof key !== "string" || key.length < 16) {
    throw new Error(
      "SESSION_ENCRYPTION_KEY 未配置或过短（至少 16 字符）：本地用 .dev.vars，线上用 `wrangler secret put`。",
    );
  }
  return key;
}
