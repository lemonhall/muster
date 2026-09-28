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
    globalSetup: ["tests/e2e/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 150_000,
  },
});
