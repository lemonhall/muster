import { env } from "cloudflare:test";

import { putModule } from "../../../src/runtime/modules";
import { callTenantRpc, resetRuntimeCache, type RuntimeCaller } from "../../../src/runtime/service";
import { insertUser } from "../../helpers/realtime";
import { createTenant } from "../../helpers/tenants";

/**
 * M8 运行时套件的工装：一个**随机租户** + 一个账号 + 往模块仓里部署源码。
 *
 * 随机租户的意义与频道/对局套件相同：模块仓的每条查询都带 `tenant_id`，随机租户
 * 等价于"每个用例一套全新的库"，用例之间不会互相看见对方的模块，也不会互相看到
 * 对方装载出来的 isolate（装载键里带着租户 id）。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export const RUNTIME_CALLER_ID = "E0000000-0000-4000-8000-00000000000E";
export const RUNTIME_CALLER_USERNAME = "runtime-caller";

export interface RuntimeWorld {
  readonly tenantId: string;
  readonly serverKey: string;
  readonly userId: string;
  readonly username: string;
}

export async function runtimeWorld(): Promise<RuntimeWorld> {
  const tenantId = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenantId}`;
  await createTenant(tenantId, serverKey, "runtime");
  await insertUser(tenantId, RUNTIME_CALLER_ID, RUNTIME_CALLER_USERNAME);
  return { tenantId, serverKey, userId: RUNTIME_CALLER_ID, username: RUNTIME_CALLER_USERNAME };
}

export function callerOf(world: RuntimeWorld): RuntimeCaller {
  return { userId: world.userId, username: world.username, sessionId: "runtime-session" };
}

/**
 * 调一次租户 RPC 并取回 payload。
 *
 * "没注册"与"模块抛异常"都是失败：用例想断言的是**模块跑出来的东西**，
 * 把这两种情况在取值时就炸出来，比让断言对着空串发呆有用。
 */
export async function payloadOf(world: RuntimeWorld, name: string, input = ""): Promise<string> {
  const invocation = await callTenantRpc(env, world.tenantId, callerOf(world), name, input);
  if (invocation.kind === "error") throw new Error(`RPC ${name} 失败：${invocation.message}`);
  if (invocation.kind === "missing") throw new Error(`RPC ${name} 没有注册`);
  return invocation.payload;
}

/**
 * 部署一组模块（一次写一个版本），随后清缓存——否则同一个测试文件里"改代码"这件事
 * 会被装载缓存吃掉，测出来的还是旧代码。revision 变了装载键本来也会变，
 * 清缓存只是让"没有模块 → 有模块"这条路径也确定性地重算。
 */
export async function deployModules(
  tenantId: string,
  modules: Readonly<Record<string, string>>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const [name, source] of Object.entries(modules)) {
    await putModule(env.DB, tenantId, name, source, String(now));
  }
  resetRuntimeCache();
}

/** 读模块仓的行：断言"部署这件事真的落库了"，而不是只看装载有没有报错。 */
export async function moduleRows(
  tenantId: string,
): Promise<{ name: string; revision: number; source: string }[]> {
  const result = await env.DB.prepare(
    "SELECT name, revision, source FROM runtime_modules WHERE tenant_id = ?1 ORDER BY name, revision",
  )
    .bind(tenantId)
    .all<{ name: string; revision: number; source: string }>();
  return result.results;
}

export async function walletOf(tenantId: string, userId: string): Promise<Record<string, number>> {
  const row = await env.DB.prepare("SELECT wallet FROM users WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, userId)
    .first<{ wallet: string }>();
  return JSON.parse(row?.wallet === undefined || row.wallet === "" ? "{}" : row.wallet) as Record<
    string,
    number
  >;
}

export async function storageRows(
  tenantId: string,
  collection: string,
): Promise<{ key: string; user_id: string; value: string }[]> {
  const result = await env.DB.prepare(
    "SELECT key, user_id, value FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 ORDER BY key",
  )
    .bind(tenantId, collection)
    .all<{ key: string; user_id: string; value: string }>();
  return result.results;
}
