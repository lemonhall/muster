/**
 * E2E 用的租户运行时模块：**在 dev server 起来之前**就写进本地 D1。
 *
 * 为什么把播种放在 global-setup 而不是用例里：模块源码存在 D1，而本地 D1 的文件
 * 在 `wrangler dev --local` 手里开着；用例跑到一半再从另一个进程写它，是拿
 * "两个进程同时写同一个 SQLite 文件"赌运气。播种放在 dev 启动前，装载路径看到的
 * 就是一个已经就位的模块仓行，这条链路上没有并发写。
 *
 * 源码里刻意只用双引号：它要被塞进一条 SQL 字符串字面量，转义规则越少越不容易写错
 * （真要出现单引号时，`sqlLiteral` 会把它翻倍，不是靠人肉避免）。
 *
 * 文件名不带 `.e2e.test.ts`，不会被 vitest 收集。
 */

export const E2E_MODULE_NAME = "e2e-game";

/**
 * 模块做三件事：回一句常量、走一遍 `nk` 的存储往返（证明能力桥真的通了）、
 * 以及数数（证明"isolate 跨请求复用、`InitModule` 只跑一次"）。
 *
 * 计数器必须是**模块级**变量：它活在 isolate 里，不是活在某一次调用里。两个真 HTTP
 * 请求分别打过来时，第二次拿到 2、而 `init` 一直是 1，才说明复用与只初始化一次都成立。
 */
export const E2E_MODULE_SOURCE = `let initCalls = 0;
let callCount = 0;

export function InitModule(ctx, logger, nk, initializer) {
  initCalls += 1;
  initializer.registerRpc("counter", async (ctx, logger, nk, payload) => {
    callCount += 1;
    return JSON.stringify({ count: callCount, init: initCalls });
  });
  initializer.registerRpc("helloworld", async (ctx, logger, nk, payload) => {
    logger.info("e2e hello %s", payload);
    return "Hello World";
  });
  initializer.registerRpc("echo", async (ctx, logger, nk, payload) => {
    await nk.storageWrite([
      { collection: "e2e-runtime", key: "echo", userId: ctx.userId, value: { payload } },
    ]);
    const rows = await nk.storageRead([
      { collection: "e2e-runtime", key: "echo", userId: ctx.userId },
    ]);
    return JSON.stringify({
      executionMode: ctx.executionMode,
      hasUser: ctx.userId.length > 0,
      rows: rows.length,
      value: rows.length === 1 ? rows[0].value : null,
    });
  });
}
`;

/** SQL 字符串字面量：把单引号翻倍，其余原样（本地 D1 的语句就是一条字符串）。 */
function sqlLiteral(text: string): string {
  return `'${text.replace(/'/gu, "''")}'`;
}

/**
 * 幂等的一条语句：固定 revision=1，跑第二遍是覆盖而不是追加新版本。
 *
 * 为什么固定 revision 而不是"每次 +1"：E2E 的结论要可复现，模块的装载键
 * （`tenant:name:revision`）就不该每一轮都在变；这一轮与上一轮看到的必须是同一个模块。
 */
export function seedRpcModuleStatement(tenantId: string, nowSec: number): string {
  return (
    "INSERT OR REPLACE INTO runtime_modules " +
    "(tenant_id, name, revision, source, created_at) VALUES (" +
    [sqlLiteral(tenantId), sqlLiteral(E2E_MODULE_NAME), "1", sqlLiteral(E2E_MODULE_SOURCE), sqlLiteral(String(nowSec))].join(
      ", ",
    ) +
    ");"
  );
}
