import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 单元 + 集成测试跑在真实 workerd 运行时里：没有 Docker，没有外部数据库。
// 池由 cloudflareTest() 插件注册（vitest 4 的写法；不再有 .../config 子路径）。
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
