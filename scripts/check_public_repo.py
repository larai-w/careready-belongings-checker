#!/usr/bin/env python3
"""Reject private working material and credentials from the public repository."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]

PRIVATE_PATH_PARTS = {
    ".private",
    "private",
    "internal",
    "confidential",
    "strategy-notes",
    "blog_drafts",
}

PRIVATE_NAME_TERMS = (
    "strategy",
    "strategic",
    "draft",
    "handoff",
    "interview-notes",
    "戦略",
    "内部",
    "機密",
    "ドラフト",
    "下書き",
    "引き継ぎ",
    "ヒアリング",
    "見積",
)

KNOWN_PRIVATE_PATHS = {
    "docs/02_開発戦略.md",
    "docs/03_マーケティング戦略.md",
    "docs/05_開発費見積もり.md",
    "docs/07_作業ノート_引き継ぎ.md",
    "docs/09_CareReady_SEO記事戦略_ドラフト.md",
    "docs/10_パイロットデモ_ヒアリングシート.md",
    "docs/11_次の作業一覧_人間と自動化.md",
    "docs/12_一般公開マイルストーン.md",
}

CONTENT_EXEMPTIONS = {
    "scripts/check_public_repo.py",
    "docs/PUBLIC_REPOSITORY_POLICY.md",
}

PRIVATE_MARKERS = (
    re.compile(r"(?im)^\s*repo-visibility\s*:\s*private\s*$"),
    re.compile(r"(?im)^\s*(?:internal only|confidential|do not distribute)\s*$"),
    re.compile(r"(?m)^\s*(?:社外秘|内部限定|外部共有禁止)\s*$"),
)

SECRET_PATTERNS = (
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("GitHub token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[opusr]_[A-Za-z0-9]{20,}\b")),
)


def git_paths(*args: str) -> list[str]:
    result = subprocess.run(
        ["git", *args, "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [item.decode("utf-8") for item in result.stdout.split(b"\0") if item]


def staged_content(path: str) -> bytes:
    return subprocess.run(
        ["git", "show", f":{path}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout


def tracked_content(path: str) -> bytes:
    return (ROOT / path).read_bytes()


def private_path_reason(path: str) -> str | None:
    normalised = PurePosixPath(path)
    lower_parts = {part.lower() for part in normalised.parts}
    lower_name = normalised.name.lower()

    if path in KNOWN_PRIVATE_PATHS or path.startswith("docs/blog_drafts/"):
        return "known local-only document"
    if lower_parts & PRIVATE_PATH_PARTS:
        return "private path component"
    if any(term in lower_name for term in PRIVATE_NAME_TERMS):
        return "private filename convention"
    if ".private." in lower_name or ".internal." in lower_name:
        return "private filename suffix"
    return None


def content_reasons(path: str, content: bytes) -> list[str]:
    if path in CONTENT_EXEMPTIONS or b"\0" in content:
        return []
    text = content.decode("utf-8", errors="replace")
    reasons = ["private classification marker" for pattern in PRIVATE_MARKERS if pattern.search(text)]
    reasons.extend(label for label, pattern in SECRET_PATTERNS if pattern.search(text))
    return sorted(set(reasons))


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true", help="check files staged for commit")
    mode.add_argument("--tracked", action="store_true", help="check all tracked files")
    mode.add_argument(
        "--working-tree",
        action="store_true",
        help="check tracked and untracked non-ignored files",
    )
    args = parser.parse_args()

    if args.staged:
        paths = git_paths("diff", "--cached", "--name-only", "--diff-filter=ACMR")
        read_content = staged_content
    elif args.tracked:
        paths = git_paths("ls-files")
        read_content = tracked_content
    else:
        paths = git_paths("ls-files", "--cached", "--others", "--exclude-standard")
        read_content = tracked_content

    errors: list[str] = []
    for path in paths:
        if reason := private_path_reason(path):
            errors.append(f"{path}: {reason}")
            continue
        try:
            content = read_content(path)
        except (OSError, subprocess.CalledProcessError) as error:
            errors.append(f"{path}: cannot inspect content ({error})")
            continue
        errors.extend(f"{path}: {reason}" for reason in content_reasons(path, content))

    if errors:
        print("Public repository policy violation:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        print("Remove these files from staging or create a sanitised public summary.", file=sys.stderr)
        return 1

    print(f"public repository policy OK: {len(paths)} file(s) checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
