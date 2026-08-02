#!/usr/bin/env python3
"""固定UIのキーボード・支援技術向け最低限の契約を検査する。"""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    text = (ROOT / "index.html").read_text(encoding="utf-8")
    for element_id in ("theme-btn", "print-btn", "share-btn", "line-share-btn"):
        match = re.search(rf'<button[^>]*id="{element_id}"[^>]*>', text)
        if not match or "aria-label=" not in match.group(0) or "title=" not in match.group(0):
            raise SystemExit(f"index.html: icon control lacks title/aria-label: {element_id}")
    for element_id in ("modal-item-name", "modal-category", "modal-locations"):
        if f'id="{element_id}"' not in text:
            raise SystemExit(f"index.html: required input is missing: {element_id}")
    print("accessibility contracts OK: fixed icon controls have title and aria-label")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
