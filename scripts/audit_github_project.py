#!/usr/bin/env python3
"""公開ProjectのIssueとStatusの不整合を報告する。変更は行わない。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=int, default=2)
    parser.add_argument("--owner", default="@me")
    args = parser.parse_args()

    command = [
        "gh", "project", "item-list", str(args.project),
        "--owner", args.owner, "--limit", "100", "--format", "json",
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        print("Project audit unavailable: GitHub API/CLI could not return the board.", file=sys.stderr)
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        return 2

    payload = json.loads(result.stdout)
    items = payload.get("items", [])
    mismatches = []
    for item in items:
        content = item.get("content") or {}
        issue_state = content.get("state")
        status = item.get("status")
        if issue_state == "CLOSED" and status != "Done":
            mismatches.append((content.get("number"), "closed issue not Done", status))
        if issue_state == "OPEN" and status == "Done":
            mismatches.append((content.get("number"), "open issue marked Done", status))

    print(f"Project items checked: {len(items)}")
    if mismatches:
        print("Status mismatches:")
        for number, reason, status in mismatches:
            print(f"- #{number}: {reason} (status={status})")
        return 1
    print("Project status consistency OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
