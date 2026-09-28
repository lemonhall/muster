import { applyD1Migrations, env } from "cloudflare:test";

// 每个测试文件跑之前把迁移灌进本地 D1。
// `applyD1Migrations` 自己有 d1_migrations 台账，重复执行是幂等的（不会重复建表）。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
