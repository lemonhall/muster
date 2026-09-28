#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyIntegrity, writeGenerated } from "./lib/integrity.mjs";

// 生成覆盖矩阵：把 docs/conformance/baseline.json 里的每条上游测试，映射到我们这边的归宿。
//
// 状态只有三种，且判定完全由脚本做，不靠人填表：
//   ported  —— 我们的某个测试文件里有 `溯源: <上游文件>::<上游测试名>` 声明
//   exempt  —— 出现在 docs/conformance/exemptions.json 里，且写了非空理由
//   planned —— 其余（默认值；"还没做"就该是 planned，不允许默默消失）
//
// 另外把 `契约源: <上游文件>::<符号>` 声明收集成"第二证据源"清单，并逐条校验
// 该文件真的存在、该符号真的出现在文件里——防止有人写一条看起来很真的假引用。
//
// 退出码非 0 的情形：上游漂移未同步、引用悬空、豁免无理由、里程碑归属有文件漏网。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const confDir = path.join(repoRoot, "docs", "conformance");
const baselineFile = path.join(confDir, "baseline.json");
const exemptionsFile = path.join(confDir, "exemptions.json");
const scopeFile = path.join(confDir, "milestone-scope.json");
const matrixFile = path.join(confDir, "coverage-matrix.md");
const testsDir = path.join(repoRoot, "tests");

const upstreamDir = process.env.MUSTER_UPSTREAM_DIR
  ? path.resolve(process.env.MUSTER_UPSTREAM_DIR)
  : path.resolve(repoRoot, "..", "nakama");

const problems = [];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(file, hint) {
  if (!fs.existsSync(file)) fail(`${path.relative(repoRoot, file)} 不存在：${hint}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${path.relative(repoRoot, file)} 不是合法 JSON：${String(error)}`);
    return undefined;
  }
}

function* walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(abs, predicate);
    else if (entry.isFile() && predicate(abs)) yield abs;
  }
}

function parseRefs(raw) {
  const refs = [];
  for (const token of raw.trim().split(/\s+/)) {
    const idx = token.indexOf("::");
    if (idx <= 0) continue;
    refs.push({ file: token.slice(0, idx), symbol: token.slice(idx + 2) });
  }
  return refs;
}

const baseline = readJson(baselineFile, "先跑 `npm run conformance:inventory` 生成清单与基线。");
const exemptions = readJson(exemptionsFile, "豁免清单缺失；可以留空但不能缺文件。");
const scope = readJson(scopeFile, "里程碑归属表缺失。");

const entries = baseline.entries.map((entry) => ({ ...entry, key: `${entry.file}::${entry.name}` }));
const byKey = new Map(entries.map((entry) => [entry.key, entry]));
const filesByName = new Map();
for (const entry of entries) {
  const list = filesByName.get(entry.file) ?? [];
  list.push(entry);
  filesByName.set(entry.file, list);
}

// --- 里程碑归属 ---------------------------------------------------------------
const milestoneOfFile = new Map();
for (const bucket of scope.buckets) {
  for (const file of bucket.files) {
    if (milestoneOfFile.has(file)) {
      problems.push(`里程碑归属重复：${file} 同时属于 ${milestoneOfFile.get(file)} 与 ${bucket.id}`);
    }
    milestoneOfFile.set(file, bucket.id);
  }
}
for (const file of filesByName.keys()) {
  if (!milestoneOfFile.has(file)) {
    problems.push(`里程碑归属漏了上游测试文件：${file}（请在 milestone-scope.json 里归类）`);
  }
}
for (const file of milestoneOfFile.keys()) {
  // 有些上游测试文件里一个 `func Test*` 都没有（纯 helper / Example），
  // 它们在清单里留不下条目，但文件本身确实存在，所以两种存在性都算通过。
  if (!filesByName.has(file) && !fs.existsSync(path.join(upstreamDir, file))) {
    problems.push(`milestone-scope.json 里的 ${file} 在上游检出里不存在（上游已改名或删除？）`);
  }
}

// --- 我们的测试声明 -----------------------------------------------------------
const ANNOTATION_RE = /(?:^|\s)(溯源|契约源):[ \t]*(\S.*)$/;

const evidence = new Map(); // entry key -> [我们的测试文件]
const derived = new Map(); // upstream file::symbol -> { files:Set, verified:boolean }

for (const abs of walkFiles(testsDir, (p) => p.endsWith(".ts"))) {
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = ANNOTATION_RE.exec(line);
    if (match === null) return;
    const kind = match[1];
    const where = `${rel}:${index + 1}`;

    for (const ref of parseRefs(match[2])) {
      if (kind === "溯源") {
        const symbols = ref.symbol.split(",").map((s) => s.trim()).filter(Boolean);
        const candidates = filesByName.get(ref.file);
        if (candidates === undefined) {
          problems.push(`${where} 的溯源引用指向不存在的上游测试文件：${ref.file}`);
          continue;
        }
        for (const symbol of symbols) {
          const targets = symbol === "*" ? candidates : candidates.filter((e) => e.name === symbol);
          if (targets.length === 0) {
            problems.push(`${where} 的溯源引用悬空：${ref.file}::${symbol}`);
            continue;
          }
          for (const target of targets) {
            const list = evidence.get(target.key) ?? [];
            if (!list.includes(rel)) list.push(rel);
            evidence.set(target.key, list);
          }
        }
        continue;
      }

      const key = `${ref.file}::${ref.symbol}`;
      const bucket = derived.get(key) ?? { files: [], verified: false };
      if (!bucket.files.includes(rel)) bucket.files.push(rel);
      const upstreamPath = path.join(upstreamDir, ref.file);
      if (!fs.existsSync(upstreamPath)) {
        problems.push(`${where} 的契约源指向不存在的上游文件：${ref.file}`);
      } else {
        const text = fs.readFileSync(upstreamPath, "utf8");
        if (!text.includes(ref.symbol)) {
          problems.push(`${where} 的契约源符号在上游文件里找不到：${ref.file}::${ref.symbol}`);
        } else {
          bucket.verified = true;
        }
      }
      derived.set(key, bucket);
    }
  });
}

// --- 豁免 ---------------------------------------------------------------------
const exemptKeys = new Set();
let unreasoned = 0;
for (const item of exemptions.exemptions ?? []) {
  const key = item.test;
  if (typeof key !== "string" || !byKey.has(key)) {
    problems.push(`exemptions.json 里的 ${String(key)} 在上游清单里不存在（上游已改名或删除？）`);
    continue;
  }
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  if (reason.length === 0) {
    unreasoned += 1;
    problems.push(`exemptions.json 里的 ${key} 没有写理由（无理由豁免不允许）`);
    continue;
  }
  if (evidence.has(key)) {
    problems.push(`${key} 既被声明为已搬运（溯源）又被豁免，二选一。`);
    continue;
  }
  exemptKeys.add(key);
}

if (problems.length > 0) {
  fail(`覆盖矩阵校验失败，共 ${problems.length} 个问题：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

// --- 渲染 ---------------------------------------------------------------------
function statusOf(key) {
  if (evidence.has(key)) return "ported";
  if (exemptKeys.has(key)) return "exempt";
  return "planned";
}

const counts = { ported: 0, planned: 0, exempt: 0 };
for (const entry of entries) counts[statusOf(entry.key)] += 1;

const bucketOrder = scope.buckets.map((bucket) => bucket.id);
const rollup = new Map(bucketOrder.map((id) => [id, { ported: 0, planned: 0, exempt: 0, total: 0 }]));
for (const entry of entries) {
  const id = milestoneOfFile.get(entry.file);
  const cell = rollup.get(id);
  if (cell === undefined) continue;
  cell.total += 1;
  cell[statusOf(entry.key)] += 1;
}

const exemptReason = new Map((exemptions.exemptions ?? []).map((item) => [item.test, item.reason]));

function render() {
  const lines = [];
  lines.push("# 覆盖矩阵（脚本生成，请勿手改）");
  lines.push("");
  lines.push("这份表回答一个问题：**上游测试套件里的每一条，在我们的项目里到底有着落没有。**");
  lines.push("");
  lines.push("状态判定全部由脚本完成，不靠人填表：`ported` = 我们的测试里写了 `溯源:` 指向它；");
  lines.push("`exempt` = 在 `docs/conformance/exemptions.json` 里且写了理由；其余一律 `planned`。");
  lines.push("`planned` 不是失败，是**待办**；但它在任何声称已交付的里程碑范围内出现，就是断链。");
  lines.push("");
  lines.push("| 项目 | 值 |");
  lines.push("|---|---|");
  lines.push(`| 上游 commit | \`${baseline.upstream.commit}\` |`);
  lines.push(`| 上游测试条目 | ${entries.length} |`);
  lines.push(`| ported | ${counts.ported} |`);
  lines.push(`| planned | ${counts.planned} |`);
  lines.push(`| exempt | ${counts.exempt} |`);
  lines.push(`| 无理由豁免 | ${unreasoned} |`);
  lines.push(`| 第二证据源引用（自主契约测试） | ${derived.size} |`);
  lines.push("");
  lines.push("## 按里程碑");
  lines.push("");
  lines.push("| 里程碑 | 范围 | 条目 | ported | planned | exempt |");
  lines.push("|---|---|---:|---:|---:|---:|");
  for (const bucket of scope.buckets) {
    const cell = rollup.get(bucket.id);
    lines.push(
      `| ${bucket.id} | ${bucket.title} | ${cell.total} | ${cell.ported} | ${cell.planned} | ${cell.exempt} |`,
    );
  }
  lines.push("");
  lines.push("## 逐条清单");
  lines.push("");
  let index = 0;
  for (const bucket of scope.buckets) {
    const own = entries.filter((entry) => milestoneOfFile.get(entry.file) === bucket.id);
    if (own.length === 0) continue;
    lines.push(`### ${bucket.id} ${bucket.title}`);
    lines.push("");
    lines.push("| # | 状态 | 上游测试 | 文件 | 证据 / 理由 |");
    lines.push("|---:|---|---|---|---|");
    for (const entry of own) {
      index += 1;
      const status = statusOf(entry.key);
      const note =
        status === "ported"
          ? evidence.get(entry.key).map((f) => `\`${f}\``).join("、")
          : status === "exempt"
            ? exemptReason.get(entry.key)
            : "—";
      lines.push(`| ${index} | ${status} | ${entry.name} | \`${entry.file}\` | ${note} |`);
    }
    lines.push("");
  }
  lines.push("## 第二证据源（自主契约测试引用到的上游非测试文件）");
  lines.push("");
  lines.push("上游测试覆盖不到的地方（尤其是 REST/身份面与频道面），对齐必须靠这些引用：");
  lines.push("每一条都是从上游实现/proto 定义里逐字推出来的契约，而不是拍脑袋写的期望值。");
  lines.push("");
  lines.push("| 上游契约源 | 我们的测试 |");
  lines.push("|---|---|");
  for (const [key, bucket] of [...derived.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| \`${key}\` | ${bucket.files.map((f) => `\`${f}\``).join("、")} |`);
  }
  return `${lines.join("\n")}\n`;
}

const integrity = verifyIntegrity(matrixFile);
if (!integrity.ok) {
  fail(
    `docs/conformance/coverage-matrix.md ${integrity.reason}。\n` +
      `请删除该文件后重新运行本脚本重新生成，不要手工修补。`,
  );
}

fs.mkdirSync(confDir, { recursive: true });
writeGenerated(matrixFile, render());

process.stdout.write(
  `entries=${entries.length} ported=${counts.ported} planned=${counts.planned} ` +
    `exempt=${counts.exempt} unreasoned_exemptions=${unreasoned} derived_citations=${derived.size}\n`,
);
