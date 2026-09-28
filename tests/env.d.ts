import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// 测试池额外注入的绑定（见 vitest.config.ts 的 miniflare.bindings）。
// 它们只存在于 vitest-pool-workers 环境里，不在 wrangler.jsonc 的运行时配置中，
// 所以单独在这里声明——增强的目标必须是 `Cloudflare.Env` 命名空间：
// 这一版 vitest-pool-workers 把 `env` 的类型定成了 `Cloudflare.Env`。
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SESSION_ENCRYPTION_KEY: string;
    }
  }
}

export {};
