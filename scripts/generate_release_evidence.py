#!/usr/bin/env python3
"""Generate a public, non-sensitive summary of recent GitHub Actions runs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="larai-w/careready-belongings-checker")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    result = subprocess.run(
        [
            "gh", "run", "list", "--repo", args.repo, "--limit", str(args.limit),
            "--json", "workflowName,status,conclusion,headSha,createdAt,url",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("Release evidence unavailable: GitHub API/CLI could not return workflow runs.", file=sys.stderr)
        return 2
    try:
        runs = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        print(f"Release evidence returned invalid JSON: {exc}", file=sys.stderr)
        return 2

    generated = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    print("# Automated release evidence")
    print(f"\nGenerated: `{generated}`")
    print("\nThis report contains workflow metadata only; it contains no user, facility, or care data.")
    print("\n| Workflow | Status | Conclusion | Commit | Run |")
    print("|---|---|---|---|---|")
    for run in runs:
        sha = (run.get("headSha") or "")[:7]
        print(
            f"| {run.get('workflowName', '')} | {run.get('status', '')} | "
            f"{run.get('conclusion') or '-'} | `{sha}` | [run]({run.get('url', '')}) |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
