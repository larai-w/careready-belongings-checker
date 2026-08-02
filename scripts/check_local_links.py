#!/usr/bin/env python3
"""Check relative Markdown links without requiring external network access."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")


def main() -> int:
    failures: list[str] = []
    checked = 0
    documents = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]
    for document in documents:
        text = document.read_text(encoding="utf-8")
        for raw_target in MARKDOWN_LINK.findall(text):
            target = raw_target.strip().strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            checked += 1
            relative = unquote(parsed.path)
            path = (document.parent / relative).resolve()
            try:
                path.relative_to(ROOT)
            except ValueError:
                failures.append(f"{document.relative_to(ROOT)}: link escapes repository: {target}")
                continue
            if not path.exists():
                failures.append(f"{document.relative_to(ROOT)}: missing target: {target}")

    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print(f"local Markdown links OK: {checked} links checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
