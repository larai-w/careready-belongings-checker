#!/usr/bin/env python3
"""Report open Issues that may need product-management follow-up.

This is intentionally report-only: it never edits Issues or Projects.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from typing import Any


REQUIRED_SECTIONS = {
    "user story": ("user story", "ユーザーストーリー", "as a "),
    "acceptance criteria": ("acceptance criteria", "受け入れ条件", "done when"),
}


def parse_timestamp(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def missing_sections(body: str) -> list[str]:
    normalised = body.casefold()
    return [
        section
        for section, markers in REQUIRED_SECTIONS.items()
        if not any(marker in normalised for marker in markers)
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="larai-w/careready-belongings-checker")
    parser.add_argument("--stale-days", type=int, default=30)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    result = subprocess.run(
        [
            "gh", "issue", "list", "--repo", args.repo, "--state", "open",
            "--limit", str(args.limit),
            "--json", "number,title,body,updatedAt,labels,url",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("Issue readiness audit unavailable: GitHub API/CLI could not return Issues.", file=sys.stderr)
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return 2

    try:
        issues: list[dict[str, Any]] = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"Issue readiness audit returned invalid JSON: {exc}", file=sys.stderr)
        return 2

    now = dt.datetime.now(dt.timezone.utc)
    stale_before = now - dt.timedelta(days=args.stale_days)
    findings: list[tuple[int, str, str]] = []
    for issue in issues:
        body = issue.get("body") or ""
        missing = missing_sections(body)
        updated_at = parse_timestamp(issue["updatedAt"])
        if missing:
            findings.append((issue["number"], "missing: " + ", ".join(missing), issue["url"]))
        if updated_at < stale_before:
            age = (now - updated_at).days
            findings.append((issue["number"], f"no update for {age} days", issue["url"]))

    print(f"Open Issues checked: {len(issues)}")
    print(f"Stale threshold: {args.stale_days} days")
    if not findings:
        print("Issue readiness OK")
        return 0

    print("Follow-up findings:")
    for number, reason, url in findings:
        print(f"- #{number}: {reason} ({url})")
    print("Report only: no Issue or Project changes were made.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
