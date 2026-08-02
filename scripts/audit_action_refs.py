#!/usr/bin/env python3
"""全workflowのAction参照を棚卸しする。デフォルトでは報告のみ。"""

from pathlib import Path
import argparse
import re


ROOT = Path(__file__).resolve().parents[1]
SHA_REF = re.compile(r"^[0-9a-f]{40}$")
USES_REF = re.compile(r"uses:\s*([^\s@]+)@([^\s#]+)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="SHA固定でないActionをエラーにする")
    args = parser.parse_args()

    mutable = []
    total = 0
    for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = USES_REF.search(line)
            if not match:
                continue
            total += 1
            action, ref = match.groups()
            if not SHA_REF.fullmatch(ref):
                mutable.append(f"{path.relative_to(ROOT)}:{line_no} {action}@{ref}")

    print(f"workflow Action refs checked: {total}")
    if mutable:
        print("mutable refs (review before high-privilege use):")
        for item in mutable:
            print(f"- {item}")
        if args.strict:
            return 1
    else:
        print("all workflow Action refs are pinned to commit SHA")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
