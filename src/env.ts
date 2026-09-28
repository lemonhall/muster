/**
 * 本 Worker 的绑定类型。
 *
 * 绑定按里程碑逐个引入，不提前占位（M0 不依赖任何绑定，所以本地不需要任何
 * Cloudflare 资源就能把测试跑绿）：
 *
 * - M1：`DB`（D1Database，账号/用户/存储索引的读模型）、`SESSION_SIGNING_KEY`（secret）
 * - M3：`SESSION_SHARD`（DurableObjectNamespace，会话分片）、`SESSION_REGISTRY`
 * - M4：`CHANNEL`（DurableObjectNamespace，每频道一个实例）
 *
 * 全局 `Env` 接口由 `wrangler types` 生成到 `worker-configuration.d.ts`，
 * 它是唯一的真相来源；这里只做一次显式转发，让业务代码 import 得到具体类型。
 */
export type Bindings = Env;
