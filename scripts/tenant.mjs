#!/usr/bin/env node
/**
 * 租户开通 CLI（ECN-0001）。
 *
 * 一个租户 = 一个游戏。开通动作要做两件事：
 *   1. 生成一个**只打印一次**的 server key（客户端拿它调用认证端点）；
 *   2. 把 `tenants` 记录写进权威库（只存 server key 的 SHA-256）。
 *
 * 默认**不动任何数据库**：只把 SQL 与可以照抄的命令打印出来，人自己决定什么时候执行。
 * 加 `--apply` 才会真的写：默认写本地 D1（workerd/miniflare 的本地库，不产生账单），
 * `--remote` 才写线上（会真的花钱，所以要显式写出来）。
 *
 * 用法：
 *   node scripts/tenant.mjs create --name "My Game"
 *   node scripts/tenant.mjs create --name "My Game" --apply
 *   node scripts/tenant.mjs create --name "My Game" --apply --remote
 *   node scripts/tenant.mjs list --apply
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_NAME = "muster";

function usage(exitCode) {
  process.stdout.write(
    [
      "用法：",
      '  node scripts/tenant.mjs create --name "My Game" [--id <uuid>] [--key <server-key>] [--apply] [--remote]',
      "  node scripts/tenant.mjs list [--apply] [--remote]",
      "",
      "说明：不传 --apply 时只打印 SQL，不碰数据库；--remote 需要同时给 --apply。",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { apply: false, remote: false, name: "", id: "", key: "" };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") options.apply = true;
    else if (token === "--remote") options.remote = true;
    else if (token === "--name") options.name = argv[++index] ?? "";
    else if (token === "--id") options.id = argv[++index] ?? "";
    else if (token === "--key") options.key = argv[++index] ?? "";
    else if (token === "-h" || token === "--help") usage(0);
    else rest.push(token);
  }
  return { options, rest };
}

/** server key：32 字节随机数的 base64url。够长、无空格、可直接放进 Basic 认证。 */
function generateServerKey() {
  return randomBytes(32).toString("base64url");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function runWrangler(command, { remote }) {
  const wranglerBin = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const args = [
    wranglerBin,
    "d1",
    "execute",
    DATABASE_NAME,
    remote ? "--remote" : "--local",
    "--command",
    command,
    "--yes",
  ];
  process.stderr.write(`$ node ${path.relative(repoRoot, wranglerBin)} d1 execute ${DATABASE_NAME} ${remote ? "--remote" : "--local"} --command ${JSON.stringify(command)}\n`);
  const output = execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
  });
  process.stdout.write(output);
}

function commandCreate(options) {
  const tenantId = options.id === "" ? randomUUID().toUpperCase() : options.id.toUpperCase();
  const serverKey = options.key === "" ? generateServerKey() : options.key;
  const name = options.name === "" ? "unnamed" : options.name;
  const now = Math.floor(Date.now() / 1000);
  const keyHash = sha256Hex(serverKey);

  const statement =
    "INSERT INTO tenants (id, name, server_key_hash, create_time, disable_time) VALUES (" +
    [sqlLiteral(tenantId), sqlLiteral(name), sqlLiteral(keyHash), String(now), "0"].join(", ") +
    ");";

  process.stdout.write(
    [
      "",
      "租户已生成（server key 只在这一次打印，请立刻存进你的密钥管理工具）",
      "--------------------------------------------------------------",
      `租户 id      : ${tenantId}`,
      `租户名       : ${name}`,
      `server key   : ${serverKey}`,
      `server key 哈希: ${keyHash}`,
      "",
      "对应的 SQL：",
      statement,
      "",
      `本地执行：  node scripts/tenant.mjs create --name ${JSON.stringify(name)} --id ${tenantId} --key <上面的 server key> --apply`,
      `线上执行：  同上再加 --remote（会写线上的 D1，确认后再执行）`,
      "",
      "客户端用法（Basic 认证，冒号后为空）：",
      `  Authorization: Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
      "",
    ].join("\n"),
  );

  if (options.apply) {
    runWrangler(statement, { remote: options.remote });
    process.stdout.write(`\n已写入 ${options.remote ? "线上" : "本地"} D1：tenants.id=${tenantId}\n`);
  } else {
    process.stdout.write("（没有 --apply，未写入任何数据库）\n");
  }
}

function commandList(options) {
  const statement = "SELECT id, name, create_time, disable_time FROM tenants ORDER BY create_time;";
  if (!options.apply) {
    process.stdout.write(`${statement}\n（没有 --apply，未连接数据库）\n`);
    return;
  }
  runWrangler(statement, { remote: options.remote });
}

const { options, rest } = parseArgs(process.argv.slice(2));
const [command] = rest;

if (command === undefined) usage(1);
if (command === "create") commandCreate(options);
else if (command === "list") commandList(options);
else usage(1);

// 让"仓库里不该出现真的 server key"这件事有个机械保障：
// 本脚本不读也不写任何 .env / .dev.vars，密钥只在 stdout 出现一次。
if (options.remote && !options.apply) {
  process.stderr.write("注意：--remote 需要和 --apply 一起用才有意义。\n");
}

if (!fs.existsSync(path.join(repoRoot, "wrangler.jsonc"))) {
  process.stderr.write("警告：当前目录看起来不是仓库根目录，wrangler 命令可能失败。\n");
}
