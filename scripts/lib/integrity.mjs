import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 给"由脚本生成、但会被人手改"的 Markdown 文件加一道完整性闸门。
//
// 做法：文件末尾写一行完整性标记（注释形式），它的值是对正文（标记行之前的所有字节）
// 的 SHA-256。脚本每次重写都会重算，所以正常的重新生成不会有任何摩擦；但任何人手工
// 改过正文、又没同步标记，下一次运行就会被拦下。
//
// 这一条直接对应计划里的反作弊条款：清单与矩阵一旦被手工编辑导致条目缺失，
// 脚本必须以非 0 退出。
const MARKER = "integrity";
// 标记必须写成**目标语言合法的注释**：`.md` 用 `<!-- -->`，源码用 `//`。
// 曾经这里不分文件类型一律写 HTML 注释，结果生成的 `.ts` 文件直接编译不过——
// 生成物也得是合法程序，这条不能靠"反正人不会看"糊过去。
const FOOTER_PATTERN = new RegExp(
  `\\n(?:<!-- ${MARKER}: body_sha256=([0-9a-f]{64}) -->|// ${MARKER}: body_sha256=([0-9a-f]{64}))\\n$`,
);

function footerFor(file, hash) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".ts" || extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return `// ${MARKER}: body_sha256=${hash}`;
  }
  return `<!-- ${MARKER}: body_sha256=${hash} -->`;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function renderWithIntegrity(body, file = "generated.md") {
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  return `${normalized}${footerFor(file, sha256(normalized))}\n`;
}

// 校验磁盘上的既有文件是否与自己的完整性标记自洽。
// 文件不存在时返回 { ok: true, existed: false }。
export function verifyIntegrity(file) {
  if (!fs.existsSync(file)) {
    return { ok: true, existed: false };
  }
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(FOOTER_PATTERN);
  if (match === null) {
    return { ok: false, existed: true, reason: "缺少完整性标记（疑似被手工编辑）" };
  }
  // 标记行之前的那个换行属于正文末尾，必须一起参与哈希，否则校验与写入会对不上。
  const body = text.slice(0, match.index + 1);
  const declared = match[1] ?? match[2];
  if (sha256(body) !== declared) {
    return { ok: false, existed: true, reason: "正文与完整性标记不一致（疑似被手工编辑）" };
  }
  return { ok: true, existed: true };
}

export function writeGenerated(file, body) {
  fs.writeFileSync(file, renderWithIntegrity(body, file), "utf8");
}
