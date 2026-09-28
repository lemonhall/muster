#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyIntegrity, writeGenerated } from "./lib/integrity.mjs";

// 扫描上游仓库，产出「可执行的规格清单」：每个 Test* 函数一条，附带 commit SHA。
//
// 结果分两处落盘：
//   docs/conformance/upstream-inventory.md  —— 给人看的清单（脚本生成，带完整性标记）
//   docs/conformance/baseline.json          —— 给机器比对的基线（漂移检测的锚点）
//
// 上游一旦漂移（新增/删除/改名测试，或换了 commit），默认运行会以非 0 退出；
// 确认要接受这次漂移时，显式跑 `node scripts/upstream-inventory.mjs --update`。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "docs", "conformance");
const inventoryFile = path.join(outDir, "upstream-inventory.md");
const baselineFile = path.join(outDir, "baseline.json");

const update = process.argv.includes("--update");

const upstreamDir = process.env.MUSTER_UPSTREAM_DIR
  ? path.resolve(process.env.MUSTER_UPSTREAM_DIR)
  : path.resolve(repoRoot, "..", "nakama");

// vendor 里会有第三方模块自带的测试；它们不是我们的对齐对象。
const SKIP_DIRS = new Set(["vendor", "node_modules", ".git", "dist", "build", "_build"]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

function git(args) {
  return execFileSync("git", ["-C", upstreamDir, ...args], { encoding: "utf8" }).trim();
}

if (!fs.existsSync(upstreamDir)) {
  fail(
    `找不到上游仓库：${upstreamDir}\n` +
      `请先克隆它，或用 MUSTER_UPSTREAM_DIR 指定路径。\n` +
      `（清单必须来自真实检出，不允许手工编造。）`,
  );
}

let upstreamCommit;
let upstreamCommitDate;
let upstreamCommitSubject;
try {
  upstreamCommit = git(["rev-parse", "HEAD"]);
  upstreamCommitDate = git(["log", "-1", "--date=iso-strict", "--format=%ad"]);
  upstreamCommitSubject = git(["log", "-1", "--format=%s"]);
} catch (error) {
  fail(`无法读取上游 git 信息（需要真实检出以便记录 commit SHA）：${String(error)}`);
}

const FILE_RE = /_test\.go$/;
const STRICT_FUNC_TEST = /^func (Test[A-Za-z0-9_]*)\s*\(/;
const LOOSE_FUNC_TEST = /^func Test/;
const SUBTEST_CALL = /\bt\.Run\(/g;

const entries = [];
const perFile = [];
let looseFuncTestCount = 0;
let totalLines = 0;
let totalSubtestCalls = 0;

for (const abs of [...walk(upstreamDir)].filter((p) => FILE_RE.test(p)).sort()) {
  const rel = path.relative(upstreamDir, abs).split(path.sep).join("/");
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);

  let testsInFile = 0;
  let subtestsInFile = 0;
  // t.Run 必须归给"它所在的那个 Test 函数"，所以边走边记住最近一个测试函数。
  let current = -1;
  for (const line of lines) {
    if (LOOSE_FUNC_TEST.test(line)) looseFuncTestCount += 1;
    const match = STRICT_FUNC_TEST.exec(line);
    if (match !== null) {
      entries.push({ file: rel, name: match[1], subtests: 0 });
      current = entries.length - 1;
      testsInFile += 1;
      continue;
    }
    const subtestCalls = (line.match(SUBTEST_CALL) ?? []).length;
    if (subtestCalls > 0) {
      subtestsInFile += subtestCalls;
      if (current >= 0) entries[current].subtests += subtestCalls;
    }
  }

  totalLines += lines.length;
  totalSubtestCalls += subtestsInFile;
  perFile.push({ file: rel, tests: testsInFile, subtests: subtestsInFile, lines: lines.length });
}

entries.sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)));

// 交叉校验：严格正则抓到的测试函数数，必须等于 `^func Test` 的行数。
// 两者不一致说明上游用了我们没识别的写法（比如泛型、行尾注释、多行签名），
// 那清单就是不可信的，宁可报错也不要悄悄少算。
if (entries.length !== looseFuncTestCount) {
  fail(
    `清单交叉校验失败：严格匹配 ${entries.length} 条，^func Test 行 ${looseFuncTestCount} 条。\n` +
      `上游可能出现了新的测试写法，先修 scripts/upstream-inventory.mjs 的解析再继续。`,
  );
}

const totals = {
  files: perFile.length,
  tests: entries.length,
  subtest_calls: totalSubtestCalls,
  lines: totalLines,
};

const baseline = {
  schema: 1,
  upstream: {
    commit: upstreamCommit,
    commit_date: upstreamCommitDate,
    commit_subject: upstreamCommitSubject,
  },
  totals,
  entries: entries.map((entry) => ({ file: entry.file, name: entry.name })),
};

function renderInventory() {
  const lines = [];
  lines.push("# 上游测试清单（脚本生成，请勿手改）");
  lines.push("");
  lines.push("本文件是**对齐基准**，不是文档：它把上游测试套件变成一份可逐条勾选的清单。");
  lines.push("每条上游 `Test*` 函数都必须在 `docs/conformance/coverage-matrix.md` 里有归宿");
  lines.push("（`ported` / `planned` / `exempt` + 理由），不允许凭空消失。");
  lines.push("");
  lines.push("| 项目 | 值 |");
  lines.push("|---|---|");
  lines.push(`| 上游检出目录 | \`${upstreamDir}\` |`);
  lines.push(`| 上游 commit | \`${upstreamCommit}\` |`);
  lines.push(`| commit 日期 | ${upstreamCommitDate} |`);
  lines.push(`| commit 主题 | ${upstreamCommitSubject.replace(/\|/g, "\\|")} |`);
  lines.push(`| 测试文件 | ${totals.files} 个 \`*_test.go\`（已排除 vendor） |`);
  lines.push(`| 测试函数 | ${totals.tests} 个 \`Test*\` |`);
  lines.push(`| t.Run 子用例调用 | ${totals.subtest_calls} 处 |`);
  lines.push(`| 测试代码行数 | ${totals.lines} |`);
  lines.push("");
  lines.push("重新生成：`npm run conformance:inventory`；接受上游漂移：`npm run conformance:inventory -- --update`。");
  lines.push("");
  lines.push("## 按文件汇总");
  lines.push("");
  lines.push("| 文件 | Test 函数 | t.Run | 行数 |");
  lines.push("|---|---:|---:|---:|");
  for (const item of perFile) {
    lines.push(`| \`${item.file}\` | ${item.tests} | ${item.subtests} | ${item.lines} |`);
  }
  lines.push("");
  lines.push("## 逐条清单");
  lines.push("");
  lines.push("| # | 测试函数 | 文件 | t.Run |");
  lines.push("|---:|---|---|---:|");
  entries.forEach((entry, index) => {
    lines.push(`| ${index + 1} | ${entry.name} | \`${entry.file}\` | ${entry.subtests} |`);
  });
  return `${lines.join("\n")}\n`;
}

const integrity = verifyIntegrity(inventoryFile);
if (!integrity.ok) {
  fail(
    `docs/conformance/upstream-inventory.md ${integrity.reason}。\n` +
      `请删除该文件后重新运行本脚本重新生成，不要手工修补。`,
  );
}

fs.mkdirSync(outDir, { recursive: true });

let drift = null;
if (fs.existsSync(baselineFile)) {
  const previous = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  const previousKeys = previous.entries.map((entry) => `${entry.file}::${entry.name}`);
  const currentKeys = baseline.entries.map((entry) => `${entry.file}::${entry.name}`);
  const added = currentKeys.filter((key) => !previousKeys.includes(key));
  const removed = previousKeys.filter((key) => !currentKeys.includes(key));
  if (previous.upstream.commit !== baseline.upstream.commit || added.length > 0 || removed.length > 0) {
    drift = { previous, added, removed };
  }
}

if (drift !== null && !update) {
  const lines = [
    "上游漂移检测：清单与已提交基线不一致。",
    `  基线 commit：${drift.previous.upstream.commit}`,
    `  当前 commit：${baseline.upstream.commit}`,
    `  新增条目：${drift.added.length}`,
    ...drift.added.slice(0, 20).map((key) => `    + ${key}`),
    `  消失条目：${drift.removed.length}`,
    ...drift.removed.slice(0, 20).map((key) => `    - ${key}`),
    "",
    "确认要接受这次漂移（并把影响同步进覆盖矩阵）时，跑：",
    "  npm run conformance:inventory -- --update",
  ];
  fail(lines.join("\n"));
}

writeGenerated(inventoryFile, renderInventory());
fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

const mode = drift !== null ? "update" : fs.existsSync(baselineFile) ? "verify" : "bootstrap";
process.stdout.write(
  `upstream_files=${totals.files} upstream_tests=${totals.tests} ` +
    `upstream_subtest_calls=${totals.subtest_calls} upstream_commit=${upstreamCommit} mode=${mode}\n`,
);
