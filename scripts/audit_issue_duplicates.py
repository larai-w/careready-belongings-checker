#!/usr/bin/env python3
"""Report likely duplicate open Issues without changing GitHub data."""

from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import sys


def normalise(title: str) -> str:
    value = title.casefold()
    value = re.sub(r"[^a-z0-9ぁ-んァ-ン一-龥]+", " ", value)
    return " ".join(value.split())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="larai-w/careready-belongings-checker")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--threshold", type=float, default=0.82)
    args = parser.parse_args()

    result = subprocess.run(
        [
            "gh", "issue", "list", "--repo", args.repo, "--state", "open",
            "--limit", str(args.limit), "--json", "number,title,url",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("Issue duplicate audit unavailable: GitHub API/CLI could not return Issues.", file=sys.stderr)
        return 2
    try:
        issues = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"Issue duplicate audit returned invalid JSON: {exc}", file=sys.stderr)
        return 2

    candidates: list[tuple[float, dict, dict]] = []
    for index, left in enumerate(issues):
        left_title = normalise(left.get("title", ""))
        for right in issues[index + 1:]:
            right_title = normalise(right.get("title", ""))
            if not left_title or not right_title:
                continue
            score = difflib.SequenceMatcher(None, left_title, right_title).ratio()
            if score >= args.threshold:
                candidates.append((score, left, right))

    print(f"Open Issues checked: {len(issues)}")
    print(f"Similarity threshold: {args.threshold:.2f}")
    if not candidates:
        print("Issue duplicate audit OK")
        return 0
    print("Possible duplicate pairs:")
    for score, left, right in sorted(candidates, reverse=True, key=lambda item: item[0]):
        print(
            f"- {score:.2f}: #{left['number']} {left['url']} <-> "
            f"#{right['number']} {right['url']}"
        )
    print("Report only: no Issue or Project changes were made.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
