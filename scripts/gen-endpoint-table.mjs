#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyIntegrity, writeGenerated } from "./lib/integrity.mjs";

// 把上游的 REST 面（apigrpc.swagger.json 里的 paths）变成我们自己的**路由契约表**。
//
// 为什么要生成而不是手抄：
//   1. 上游 REST 面有 77 条路径、91 个操作（含方法维度）。手抄一定会漏、会改名。
//   2. 只要这张表在版本控制里，我们就能用它做两件事：
//      - 已实现的路径走真实处理器，未实现的路径返回 501 Unimplemented（诚实：这条
//        路径上游有、我们还没做），未知路径才 404（上游语义）。
//      - 与上游漂移做机器对账（scripts/check-endpoint-table.mjs）。
//
// 生成物里**不写**上游的 operationId 前缀，只保留去掉前缀后的动作名（如 GetAccount），
// 避免把上游品牌名带进我们自己的源码标识符。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(repoRoot, "src", "http", "endpoints.generated.ts");

const upstreamDir = process.env.MUSTER_UPSTREAM_DIR
  ? path.resolve(process.env.MUSTER_UPSTREAM_DIR)
  : path.resolve(repoRoot, "..", "nakama");
const swaggerPath = path.join(upstreamDir, "apigrpc", "apigrpc.swagger.json");

if (!fs.existsSync(swaggerPath)) {
  process.stderr.write(
    `找不到上游 swagger：${swaggerPath}\n请先克隆上游，或用 MUSTER_UPSTREAM_DIR 指定路径。\n`,
  );
  process.exit(1);
}

const swagger = JSON.parse(fs.readFileSync(swaggerPath, "utf8"));
const upstreamCommit = execFileSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

/**
 * 鉴权要求的判定要**同时**看两处，否则会错：
 *   1. swagger：根上是 `security: [{BearerJwt: []}]`（默认要用户令牌）；
 *      认证类端点在自己的 operation 上覆盖成 `[{BasicAuth: []}]`（服务端密钥）；
 *      RPC 面是 `[{BearerJwt: [], HttpKeyAuth: []}]`（二选一）。
 *   2. 服务端拦截器 `server/api.go::securityInterceptorFunc`：它把
 *      `/nakama.api.Nakama/Healthcheck` 硬豁免成"无鉴权"——swagger 里看不出来。
 */
function classifyAuth(operation, operationName) {
  if (operationName === "Healthcheck") return "none";
  const security = operation.security ?? [];
  for (const requirement of security) {
    const keys = Object.keys(requirement);
    if (keys.includes("BearerJwt") && keys.includes("HttpKeyAuth")) return "user-or-http-key";
    if (keys.includes("BasicAuth")) return "server-key";
  }
  // 没有覆盖就是继承根上的 BearerJwt。
  return "user";
}

const endpoints = [];
for (const [routePath, methods] of Object.entries(swagger.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const rawId = operation.operationId ?? "";
    const operationName = rawId.includes("_") ? rawId.slice(rawId.indexOf("_") + 1) : rawId;
    endpoints.push({
      method: method.toUpperCase(),
      path: routePath,
      operation: operationName,
      auth: classifyAuth(operation, operationName),
    });
  }
}
endpoints.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));

function render() {
  const lines = [];
  lines.push("// 本文件由 `node scripts/gen-endpoint-table.mjs` 生成，请勿手改。");
  lines.push("//");
  lines.push("// 来源：上游 `apigrpc/apigrpc.swagger.json` 的 paths（去掉厂商前缀后的动作名）。");
  lines.push(`// 上游 commit：${upstreamCommit}`);
  lines.push("//");
  lines.push("// 用途：路由分发的唯一真相来源。已实现的路径走真实处理器；表里存在但尚未实现的");
  lines.push("// 路径返回 501 Unimplemented（与上游 HTTPStatusFromCode 对 Unimplemented 的映射一致），");
  lines.push("// 表里不存在的路径才返回 404 Not Found。");
  lines.push("");
  lines.push('import type { UpstreamEndpoint } from "./endpoints";');
  lines.push("");
  lines.push("export const UPSTREAM_COMMIT = " + JSON.stringify(upstreamCommit) + ";");
  lines.push("");
  lines.push("export const UPSTREAM_REST_ENDPOINTS: readonly UpstreamEndpoint[] = [");
  for (const endpoint of endpoints) {
    lines.push(
      `  { method: ${JSON.stringify(endpoint.method)}, path: ${JSON.stringify(endpoint.path)}, ` +
        `operation: ${JSON.stringify(endpoint.operation)}, auth: ${JSON.stringify(endpoint.auth)} },`,
    );
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

if (!fs.existsSync(outFile)) {
  // 首次生成。
} else {
  const integrity = verifyIntegrity(outFile);
  if (!integrity.ok) {
    process.stderr.write(
      `${path.relative(repoRoot, outFile)} ${integrity.reason}。\n` +
        `请删除该文件后重新运行本脚本重新生成，不要手工修补。\n`,
    );
    process.exit(1);
  }
}

writeGenerated(outFile, render());

const counts = endpoints.reduce((acc, endpoint) => {
  acc[endpoint.auth] = (acc[endpoint.auth] ?? 0) + 1;
  return acc;
}, {});
process.stdout.write(
  `endpoints=${endpoints.length} paths=${Object.keys(swagger.paths).length} ` +
    `auth_user=${counts.user ?? 0} auth_server_key=${counts["server-key"] ?? 0} ` +
    `auth_user_or_http_key=${counts["user-or-http-key"] ?? 0} auth_none=${counts.none ?? 0} ` +
    `upstream_commit=${upstreamCommit}\n`,
);
