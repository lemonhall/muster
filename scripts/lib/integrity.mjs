import { createHash } from "node:crypto";
import fs from "node:fs";

// 给"由脚本生成、但会被人手改"的 Markdown 文件加一道完整性闸门。
//
// 做法：文件末尾写一行完整性标记（注释形式），它的值是对正文（标记行之前的所有字节）
// 的 SHA-256。脚本每次重写都会重算，所以正常的重新生成不会有任何摩擦；但任何人手工
// 改过正文、又没同步标记，下一次运行就会被拦下。
//
// 这一条直接对应计划里的反作弊条款：清单与矩阵一旦被手工编辑导致条目缺失，
// 脚本必须以非 0 退出。
const MARKER = "integrity";
const FOOTER_PATTERN = new RegExp(`\\n<!-- ${MARKER}: body_sha256=([0-9a-f]{64}) -->\\n?$`);

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function renderWithIntegrity(body) {
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  return `${normalized}<!-- ${MARKER}: body_sha256=${sha256(normalized)} -->\n`;
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
  const body = text.slice(0, match.index);
  if (sha256(body) !== match[1]) {
    return { ok: false, existed: true, reason: "正文与完整性标记不一致（疑似被手工编辑）" };
  }
  return { ok: true, existed: true };
}

export function writeGenerated(file, body) {
  fs.writeFileSync(file, renderWithIntegrity(body), "utf8");
}
