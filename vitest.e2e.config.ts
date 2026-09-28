import { defineConfig } from "vitest/config";

/**
 * E2E 配置：**不**用 cloudflare pool。
 *
 * 它是与 `vitest.config.ts` 完全独立的第二条通道——测试通过真实 HTTP 访问
 * 一个真实启动的 `wrangler dev` 进程，而不是 import 处理函数直接调用。
 * 这样"能跑"才有说服力：路由、序列化、状态码都要真的过一遍网络。
 *
 * 由于本机没有 Docker、也没有数据库，E2E 的目标是本地 workerd。
 * 想指向别处（未来的预发环境）时设 `MUSTER_E2E_TARGET` 即可。
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // 第一个是守夜人（tests/port-guard.ts）：`wrangler dev` 给 UserWorker 分配的也是随机端口，
    // 抽到 undici 的禁用端口时，整条 HTTP 通道会以 500 的形式随机变红。
    globalSetup: ["./tests/port-guard.ts", "./tests/e2e/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 150_000,
    /**
     * **文件串行**。这不是图省事，是本地 `wrangler dev` 的硬限制：
     * 所有 E2E 文件共用同一个 dev server，而 dev server 前面那层 ProxyWorker
     * 同时扛着"5 个测试文件 × 各自的用例 + 实时测试的长连接"时，会丢掉到
     * UserWorker 的连接并抛 `Network connection lost`（重试耗尽后表现为 500）。
     *
     * 实测记录（2026-09-28，M3 收尾）：
     *  - 并发跑 5 个文件：8 个用例红（6 × `expected 500 to be 200`、2 ×
     *    WebSocket 用例 30s 超时）；服务端日志全是 `Error inside ProxyWorker ...
     *    Network connection lost`。
     *  - 单跑其中任何一个文件：全绿。
     *  - 串行跑全部：全绿（见 M3 Review 的 evidence）。
     *
     * 这是**测试工装**的并发上限，不是被测代码的缺陷；要让 E2E 结论可信，
     * 就不能让基础设施的抖动混进断言。
     */
    fileParallelism: false,
  },
});
