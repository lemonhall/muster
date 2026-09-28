import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 单元 + 集成测试跑在真实 workerd 运行时里：没有 Docker，没有外部数据库。
// 池由 cloudflareTest() 插件注册（vitest 4 的写法；不再有 .../config 子路径）。
//
// 迁移在**配置期**（Node 侧）读盘，作为 binding 注入进 workerd；测试里的
// `tests/setup.ts` 再调用 `applyD1Migrations` 把它们灌进本地 D1。
// 这样测试不需要 Docker、不需要网络，也不需要预先跑任何外部命令。
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // 测试专用的签名密钥。生产必须走 `wrangler secret put`，仓库里不存真密钥。
            SESSION_ENCRYPTION_KEY: "test-only-session-encryption-key",
          },
        },
      }),
    ],
    test: {
      include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
      setupFiles: ["./tests/setup.ts"],
      // 守夜人：见 tests/port-guard.ts。占住 undici 的禁用端口，免得 miniflare
      // 随机抽到它们时整个测试文件"启动失败"（Errors 1 error，而不是断言红）。
      globalSetup: ["./tests/port-guard.ts"],
    },
  };
});
