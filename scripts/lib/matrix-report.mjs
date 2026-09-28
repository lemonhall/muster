/**
 * 覆盖矩阵的**渲染**。
 *
 * 与校验逻辑（`scripts/conformance-matrix.mjs`）分开：那边只回答"哪些条目不合规"，
 * 这里只负责把判定结果写成人看的 markdown。
 *
 * 分开的另一个好处：主脚本不会因为"表越长、模板越花"而长过 300 行——
 * 单文件 ≤300 行是全局宪法条款（`C:\Users\lemon\.codex\AGENTS.md`）。
 */

function statusOf(evidence, exemptKeys, key) {
  if (evidence.has(key)) return "ported";
  if (exemptKeys.has(key)) return "exempt";
  return "planned";
}

/**
 * @returns {{ markdown: string, counts: {ported:number, planned:number, exempt:number} }}
 */
export function renderMatrixReport({
  baseline,
  entries,
  scope,
  milestoneOfFile,
  evidence,
  exemptKeys,
  exemptReason,
  derived,
  unreasonedCount,
}) {
  const status = (key) => statusOf(evidence, exemptKeys, key);

  const counts = { ported: 0, planned: 0, exempt: 0 };
  for (const entry of entries) counts[status(entry.key)] += 1;

  const rollup = new Map(scope.buckets.map((bucket) => [bucket.id, { ported: 0, planned: 0, exempt: 0, total: 0 }]));
  for (const entry of entries) {
    const cell = rollup.get(milestoneOfFile.get(entry.file));
    if (cell === undefined) continue;
    cell.total += 1;
    cell[status(entry.key)] += 1;
  }

  const lines = [];
  lines.push("# 覆盖矩阵（脚本生成，请勿手改）");
  lines.push("");
  // 同 upstream-inventory.md：生成物，且刻意单文件——它的价值是"总数与逐条去向在同一张表里
  // 自洽"，拆开就没法只看一处判断有没有条目漏网。
  lines.push("> **为什么它是一个整块**：本文件由 `npm run conformance:matrix` 整体重写，");
  lines.push("> 价值全在“逐条去向与总数在同一张表里自洽”。拆成多份就没法只看一处判断有没有条目漏网，");
  lines.push("> 所以按仓库约定（单文件 ≤300 行）作为生成物整体豁免拆分。");
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
  lines.push(`| 无理由豁免 | ${unreasonedCount} |`);
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
      const state = status(entry.key);
      const note =
        state === "ported"
          ? evidence.get(entry.key).map((file) => `\`${file}\``).join("、")
          : state === "exempt"
            ? exemptReason.get(entry.key)
            : "—";
      lines.push(`| ${index} | ${state} | ${entry.name} | \`${entry.file}\` | ${note} |`);
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
    lines.push(`| \`${key}\` | ${bucket.files.map((file) => `\`${file}\``).join("、")} |`);
  }

  return { markdown: `${lines.join("\n")}\n`, counts };
}
