#!/usr/bin/env python
"""文档卫生检查。任意一项不过就以非 0 退出。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 检查四件事：
#   1. 需求编号连续：docs/prd/PRD-*.md 里的 REQ-XXXX-NNN 必须从 001 起连续。
#   2. 计划含 PRD Trace：docs/plan/v*.md（索引除外）必须有 `## PRD Trace` 段，
#      且该段至少引用一个需求编号。
#   3. 无模糊词：TODO / TBD / 待补充 / 若干 / 等等 / 尽量 / 尽可能 / 酌情 / 视情况 / 差不多。
#      确有必要时，在该行末尾加 `<!-- doc-hygiene: allow -->` 显式放行（要过 review）。
#   4. 内部链接无断链：Markdown 相对链接指向的文件必须真实存在。
#
# ``` 围栏内的内容不参与模糊词与链接检查。

SKIP_DIRS = {"node_modules", ".git", ".wrangler", "dist", "build", "__pycache__"}

REQ_RE = re.compile(r"REQ-\d{4}-\d{3}")
PLAN_TRACE_HEADING_RE = re.compile(r"^##\s+PRD Trace\s*$", re.MULTILINE)
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
ALLOW_MARKER = "doc-hygiene: allow"

VAGUE_WORDS: tuple[str, ...] = (
    "TODO",
    "TBD",
    "待补充",
    "若干",
    "等等",
    "尽量",
    "尽可能",
    "酌情",
    "视情况",
    "差不多",
)


class Finding:
    def __init__(self, check: str, path: Path, line: int, message: str) -> None:
        self.check = check
        self.path = path
        self.line = line
        self.message = message

    def render(self, root: Path) -> str:
        try:
            rel = self.path.relative_to(root).as_posix()
        except ValueError:
            rel = self.path.as_posix()
        location = f"{rel}:{self.line}" if self.line else rel
        return f"[{self.check}] {location}: {self.message}"


def iter_markdown(root: Path) -> list[Path]:
    found: list[Path] = []
    for path in sorted(root.rglob("*.md")):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        found.append(path)
    return found


def strip_fenced_code(text: str) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    in_fence = False
    for number, line in enumerate(text.splitlines(), start=1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        lines.append((number, line))
    return lines


def check_requirement_numbering(root: Path, found: list[Finding]) -> int:
    prd_dir = root / "docs" / "prd"
    prd_files = sorted(prd_dir.glob("*.md")) if prd_dir.is_dir() else []
    if not prd_files:
        found.append(Finding("req-numbering", prd_dir, 0, "找不到任何 PRD 文件"))
        return 0
    numbers: list[int] = []
    for path in prd_files:
        text = path.read_text(encoding="utf-8")
        for match in REQ_RE.finditer(text):
            numbers.append(int(match.group(0).rsplit("-", 1)[1]))
    if not numbers:
        found.append(Finding("req-numbering", prd_files[0], 0, "PRD 里没有任何需求编号"))
        return 0
    missing = sorted(set(range(1, max(numbers) + 1)) - set(numbers))
    if missing:
        rendered = ", ".join(f"{n:03d}" for n in missing)
        found.append(Finding("req-numbering", prd_files[0], 0, f"需求编号不连续，缺：{rendered}"))
    return len(set(numbers))


def check_plan_trace(root: Path, found: list[Finding]) -> int:
    plan_dir = root / "docs" / "plan"
    plans = sorted(p for p in plan_dir.glob("*.md") if not p.stem.endswith("-index")) if plan_dir.is_dir() else []
    for path in plans:
        text = path.read_text(encoding="utf-8")
        if not PLAN_TRACE_HEADING_RE.search(text):
            found.append(Finding("plan-trace", path, 0, "缺少 PRD Trace 段"))
            continue
        section = PLAN_TRACE_HEADING_RE.split(text, maxsplit=1)[1]
        section = section.split("\n## ", maxsplit=1)[0]
        if not REQ_RE.search(section):
            found.append(Finding("plan-trace", path, 0, "PRD Trace 段里没有引用任何需求编号"))
    return len(plans)


def check_vague_words(markdown: list[Path], found: list[Finding]) -> int:
    scanned = 0
    for path in markdown:
        text = path.read_text(encoding="utf-8")
        for number, line in strip_fenced_code(text):
            scanned += 1
            if ALLOW_MARKER in line:
                continue
            for word in VAGUE_WORDS:
                if word in line:
                    found.append(
                        Finding(
                            "vague-word",
                            path,
                            number,
                            f"出现模糊词「{word}」；确有必要时在该行末尾加显式放行标记",
                        )
                    )
    return scanned


def check_links(markdown: list[Path], found: list[Finding]) -> int:
    checked = 0
    for path in markdown:
        text = path.read_text(encoding="utf-8")
        for number, line in strip_fenced_code(text):
            for match in LINK_RE.finditer(line):
                target = match.group(1).strip()
                if target.startswith(("http://", "https://", "mailto:", "tel:", "#")):
                    continue
                pure_path = target.split("#", maxsplit=1)[0]
                if not pure_path:
                    continue
                checked += 1
                if not (path.parent / pure_path).resolve().exists():
                    found.append(Finding("broken-link", path, number, f"链接目标不存在：{target}"))
    return checked


# 文档里出现"NNN 个 Test*"或"NNN 个 *_test.go"这类硬数字时，必须与
# docs/conformance/baseline.json（脚本生成）里的权威数字一致。
# 这条闸门的存在理由很具体：这两个数字曾经是手工统计出来的，而且统计时踩了
# "PowerShell Select-String 默认大小写不敏感"的坑，把 func testX(...) 也算成了测试。
INVENTORY_NUMBER_PATTERNS = (
    (re.compile(r"(\d[\d,]*)\s*个\s*`?\*_test\.go`?"), "files", "测试文件数"),
    (re.compile(r"(\d[\d,]*)\s*个\s*`?Test\*`?"), "tests", "测试函数数"),
)


def check_inventory_numbers(root: Path, markdown: list[Path], found: list[Finding]) -> int:
    baseline_file = root / "docs" / "conformance" / "baseline.json"
    if not baseline_file.is_file():
        found.append(
            Finding("inventory-number", baseline_file, 0, "缺少基线文件，无法校验文档里的统计数字")
        )
        return 0
    baseline = json.loads(baseline_file.read_text(encoding="utf-8"))
    totals = baseline["totals"]
    per_file: dict[str, int] = {}
    for entry in baseline["entries"]:
        key = entry["file"]
        per_file[key] = per_file.get(key, 0) + 1

    checked = 0
    for path in markdown:
        for number, line in strip_fenced_code(path.read_text(encoding="utf-8")):
            for pattern, key, label in INVENTORY_NUMBER_PATTERNS:
                for match in pattern.finditer(line):
                    checked += 1
                    claimed = int(match.group(1).replace(",", ""))
                    expected = int(totals[key])
                    if claimed != expected:
                        found.append(
                            Finding(
                                "inventory-number",
                                path,
                                number,
                                f"{label}写成 {claimed}，与基线（{expected}）不一致",
                            )
                        )
            checked += check_single_file_numbers(path, number, line, per_file, found)
    return checked


# 单文件计数：文档里凡是把某个 `*_test.go` 和紧邻的「NNN 条 / NNN 个」写在一起，
# 就要和基线里那个文件的实际条目数对账。
# 这条闸门的由来：存储那一块曾被写成"58 条"（实际 54+3=57），而且是写在
# 一句不含文件名的句子里，上面那两条总量正则抓不到。
SINGLE_FILE_PATTERN = re.compile(r"`([A-Za-z0-9_./-]*_test\.go)`\s*[（(]?\s*(\d[\d,]*)\s*[条个]")


def check_single_file_numbers(
    path: Path,
    number: int,
    line: str,
    per_file: dict[str, int],
    found: list[Finding],
) -> int:
    checked = 0
    for match in SINGLE_FILE_PATTERN.finditer(line):
        name = match.group(1)
        claimed = int(match.group(2).replace(",", ""))
        suffix = name if not name.startswith(("./", "/")) else name.lstrip("./")
        candidates = [key for key in per_file if key == suffix or key.endswith("/" + suffix)]
        if len(candidates) != 1:
            found.append(
                Finding(
                    "inventory-number",
                    path,
                    number,
                    f"`{name}` 无法唯一对应到基线里的测试文件（匹配到 {len(candidates)} 个）",
                )
            )
            continue
        checked += 1
        expected = per_file[candidates[0]]
        if claimed != expected:
            found.append(
                Finding(
                    "inventory-number",
                    path,
                    number,
                    f"`{name}` 的测试数写成 {claimed}，与基线（{expected}）不一致",
                )
            )
    return checked


def main() -> int:
    parser = argparse.ArgumentParser(description="文档卫生检查")
    parser.add_argument("--root", default=".", help="仓库根目录")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"根目录不存在：{root}", file=sys.stderr)
        return 1

    markdown = iter_markdown(root)
    found: list[Finding] = []
    requirements = check_requirement_numbering(root, found)
    plans = check_plan_trace(root, found)
    lines = check_vague_words(markdown, found)
    links = check_links(markdown, found)
    numbers = check_inventory_numbers(root, markdown, found)

    for finding in found:
        print(finding.render(root))

    print(
        f"docs_hygiene: files={len(markdown)} requirements={requirements} plans={plans} "
        f"lines={lines} links={links} inventory_numbers={numbers} problems={len(found)}"
    )
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())
