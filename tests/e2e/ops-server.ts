import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * 限流那条 E2E 用的**专属 dev server**。
 *
 * 为什么不复用 global-setup 起的那个：`RATE_LIMIT_PER_WINDOW` / `RATE_LIMIT_WINDOW_MS`
 * 是**全局**变量，一拧就把整套 E2E 的所有租户都限制住。而两边的诉求正好相反：
 *
 *   - 别的用例（尤其存储那条 10000 对象的翻页：约 200 条请求挤在 50 秒内，约 4 次/秒）
 *     需要阈值**高到不可能被打满**，否则它们会因为 429 随机变红——那是测试工装的缺陷；
 *   - 限流用例需要阈值**低到几秒内打满**（本地 workerd 上一条约 0.4 秒，阈值 60 就要等
 *     半分钟，阈值 250 要等两分钟）。
 *
 * 两个诉求在同一个配置下无法同时满足（允许速率必须同时高于 4 次/秒、低于 2 次/秒），
 * 所以这套 E2E 跑**两个部署**：主线那个把限流关着（缺省即关闭），限流那条自己起一个
 * 阈值很低的实例。这也更贴近现实——阈值本来就是**每个部署各自拧**的旋钮。
 *
 * 这个实例有自己的 `--persist-to` 目录，因此它的 D1 与主实例完全隔离：它的租户行、
 * 迁移状态、request_log 都不会漏进主实例，反之亦然。仍然是 `--local`，
 * **不指向任何 Cloudflare 账号资源**。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const persistDir = path.join(repoRoot, ".wrangler", "ops-e2e-state");

export const opsPort = "8789";
export const opsBaseUrl = `http://127.0.0.1:${opsPort}`;

/** 限流用例的两个租户：唯一的区别就是 id，用来证明"桶按租户分"。 */
export interface OpsTenant {
  readonly id: string;
  readonly name: string;
  readonly serverKey: string;
}

export const opsTenantA: OpsTenant = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "ops-a",
  serverKey: "ops-e2e-tenant-a-server-key-do-not-use-in-production",
};

export const opsTenantB: OpsTenant = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "ops-b",
  serverKey: "ops-e2e-tenant-b-server-key-do-not-use-in-production",
};

export interface OpsServerOptions {
  readonly limit: number;
  readonly windowMs: number;
}

let child: ChildProcess | undefined;
const captured: string[] = [];

function wranglerPath(): string {
  return path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
}

function runWrangler(args: string[]): void {
  execFileSync(process.execPath, [wranglerPath(), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
}

/** 在这个实例自己的持久化目录里应用迁移，并登记两个租户。 */
function prepareLocalDatabase(): void {
  runWrangler(["d1", "migrations", "apply", "muster", "--local", "--persist-to", persistDir]);
  const now = Math.floor(Date.now() / 1000);
  for (const tenant of [opsTenantA, opsTenantB]) {
    const keyHash = createHash("sha256").update(tenant.serverKey, "utf8").digest("hex");
    // 幂等：本地目录跨运行保留，重跑不该撞主键。
    const statement =
      "INSERT OR REPLACE INTO tenants (id, name, server_key_hash, create_time, disable_time) " +
      `VALUES ('${tenant.id}', '${tenant.name}', '${keyHash}', ${now}, 0);`;
    runWrangler(["d1", "execute", "muster", "--local", "--persist-to", persistDir, "--command", statement, "--yes"]);
  }
}

async function waitForReady(baseUrl: string, log: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthcheck`);
      const body = res.status === 200 ? await res.text() : "";
      // 与 global-setup 同一条理由：只看状态码会被"外层先给了个 200"骗过去。
      if (res.status === 200 && body === "{}") return;
      lastError = `GET /healthcheck -> ${res.status} ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`限流实例在就绪前退出，退出码 ${child.exitCode}\n--- 输出 ---\n${log.join("")}`);
    }
    await delay(250);
  }
  throw new Error(
    `90s 内没等到 ${baseUrl}/healthcheck 就绪（最后一次失败：${lastError}）\n` +
      `--- 输出 ---\n${log.join("")}`,
  );
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 可能已经自己退出了。
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 同上。
  }
}

/** 起一个阈值很低的实例。`afterAll` 必须配对调用 `stopOpsServer`。 */
export async function startOpsServer(options: OpsServerOptions): Promise<void> {
  prepareLocalDatabase();
  child = spawn(
    process.execPath,
    [
      wranglerPath(),
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      opsPort,
      "--inspector-port",
      String(Number(opsPort) + 1000),
      "--local",
      "--persist-to",
      persistDir,
      "--var",
      "SESSION_ENCRYPTION_KEY:ops-e2e-only-session-encryption-key",
      // 这两个旋钮就是本用例的被测对象：缺省是**关闭**，不拧开永远不会有 429。
      "--var",
      `RATE_LIMIT_PER_WINDOW:${options.limit}`,
      "--var",
      `RATE_LIMIT_WINDOW_MS:${options.windowMs}`,
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  child.stdout?.on("data", (chunk) => captured.push(String(chunk)));
  child.stderr?.on("data", (chunk) => captured.push(String(chunk)));
  try {
    await waitForReady(opsBaseUrl, captured);
  } catch (error) {
    if (child.pid !== undefined) killTree(child.pid);
    throw error;
  }
}

export function stopOpsServer(): void {
  if (child?.pid !== undefined) killTree(child.pid);
  child = undefined;
}
