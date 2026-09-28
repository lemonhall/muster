import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 监听端口。测试侧用同一个变量算出 base URL，两边不会漂移。 */
export const e2ePort = process.env.MUSTER_E2E_PORT ?? "8788";

/**
 * E2E 用的测试租户。固定的 id/key 与固定的主密钥，让 E2E 结论可复现：
 * 任何一次运行看到的都是同一个租户，而不是"上一轮留下的那个"。
 *
 * 这两个值只存在于本地 workerd 的 `.wrangler/state` 里，**不指向任何 Cloudflare 账号资源**。
 */
export const e2eTenant = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "e2e",
  serverKey: "e2e-server-key-do-not-use-in-production",
};

/**
 * 第二个租户。存在的唯一目的：让"多租户真的隔离"这条结论**在真实 HTTP 通道上**被验证，
 * 而不是只在单元/集成测试里成立。没有它，跨租户越权就没有 E2E 证据。
 */
export const e2eTenantB = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "e2e-b",
  serverKey: "e2e-tenant-b-server-key-do-not-use-in-production",
};

export const e2eSessionKey = "e2e-only-session-encryption-key";

const readyTimeoutMs = 90_000;
const pollIntervalMs = 250;

let child: ChildProcess | undefined;
const captured: string[] = [];

function wranglerPath(): string {
  return path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
}

function runWrangler(args: string[]): string {
  return execFileSync(process.execPath, [wranglerPath(), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
}

/**
 * 准备本地 D1：先应用迁移，再写入 E2E 租户。
 *
 * 全部是 `--local`：数据落在 `.wrangler/state`，不连线上数据库，
 * 因此这套 E2E **不产生任何 Cloudflare 账单**。
 */
function prepareLocalDatabase(): void {
  runWrangler(["d1", "migrations", "apply", "muster", "--local"]);
  const now = Math.floor(Date.now() / 1000);
  for (const tenant of [e2eTenant, e2eTenantB]) {
    const keyHash = createHash("sha256").update(tenant.serverKey, "utf8").digest("hex");
    const statement =
      "INSERT OR REPLACE INTO tenants (id, name, server_key_hash, create_time, disable_time) VALUES " +
      `('${tenant.id}', '${tenant.name}', '${keyHash}', ${now}, 0);`;
    runWrangler(["d1", "execute", "muster", "--local", "--command", statement, "--yes"]);
  }
}

async function waitForReady(baseUrl: string, log: string[]): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthcheck`);
      // 就绪判定要看**内容**：只看 200 会被"路由还没挂上、外层先给了个 200"骗过去。
      // 真实的 healthcheck 一定是 `{}`（google.protobuf.Empty 的 protojson 形状）。
      const body = res.status === 200 ? await res.text() : "";
      if (res.status === 200 && body === "{}") {
        return;
      }
      lastError = `GET /healthcheck -> ${res.status} ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(
        `wrangler dev 在就绪前退出，退出码 ${child.exitCode}\n--- 子进程输出 ---\n${log.join("")}`,
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `${readyTimeoutMs}ms 内没等到 ${baseUrl}/healthcheck 就绪（最后一次失败：${lastError}）\n` +
      `--- 子进程输出 ---\n${log.join("")}`,
  );
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    // wrangler dev 会再拉起 workerd；只 kill 父进程会留下孤儿进程占着端口。
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 进程可能已经自己退出了，这里不值得让 E2E 变红。
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 同上。
  }
}

export async function setup(): Promise<void> {
  const baseUrl = `http://127.0.0.1:${e2ePort}`;
  const wranglerBin = wranglerPath();

  // 迁移 + 租户登记都走本地 D1（`--local`），不碰任何线上资源。
  prepareLocalDatabase();

  child = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      e2ePort,
      "--inspector-port",
      String(Number(e2ePort) + 1000),
      "--local",
      // 主密钥由命令行注入：仓库里不放真密钥，E2E 也不需要 .dev.vars 存在。
      "--var",
      `SESSION_ENCRYPTION_KEY:${e2eSessionKey}`,
      // 匹配器的闹钟周期（上游 `matchmaker.interval_sec` 的毫秒版）。默认 15 秒，
      // E2E 等不起，调到 200ms——这样成局是"几秒内必然发生"，而不是"看运气"。
      "--var",
      "MATCHMAKER_INTERVAL_MS:200",
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
  // 默认只把子进程输出攒在内存里（就绪失败时随错误一起抛出）。排查 500 / 超时时
  // 用 `MUSTER_E2E_VERBOSE=1` 把它实时打到测试输出里，否则服务端只能靠猜。
  if (process.env.MUSTER_E2E_VERBOSE === "1") {
    const echo = (chunk: unknown) => process.stdout.write(`[e2e:server] ${String(chunk)}`);
    child.stdout?.on("data", echo);
    child.stderr?.on("data", echo);
  }

  try {
    await waitForReady(baseUrl, captured);
  } catch (error) {
    if (child.pid !== undefined) {
      killTree(child.pid);
    }
    throw error;
  }

  // 让 E2E 的输出里留下"真的起了进程、真的监听了这个地址"的痕迹。
  process.stdout.write(`[e2e] muster 本地 Worker 已就绪：${baseUrl} (pid=${child.pid})\n`);
}

export async function teardown(): Promise<void> {
  if (child?.pid !== undefined) {
    killTree(child.pid);
  }
}
