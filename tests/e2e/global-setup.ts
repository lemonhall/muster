import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 监听端口。测试侧用同一个变量算出 base URL，两边不会漂移。 */
export const e2ePort = process.env.MUSTER_E2E_PORT ?? "8788";

const readyTimeoutMs = 90_000;
const pollIntervalMs = 250;

let child: ChildProcess | undefined;

async function waitForReady(baseUrl: string, captured: string[]): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthcheck`);
      if (res.status === 200) {
        return;
      }
      lastError = `GET /healthcheck -> ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(
        `wrangler dev 在就绪前退出，退出码 ${child.exitCode}\n--- 子进程输出 ---\n${captured.join("")}`,
      );
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `${readyTimeoutMs}ms 内没等到 ${baseUrl}/healthcheck 就绪（最后一次失败：${lastError}）\n` +
      `--- 子进程输出 ---\n${captured.join("")}`,
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
  const wranglerBin = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const captured: string[] = [];

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
