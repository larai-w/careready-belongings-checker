#!/usr/bin/env python3
"""Security baseline workflowの固定・危険トリガー契約を検査する。"""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/security-baseline.yml"
SHA_REF = re.compile(r"uses:\s+[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$")


def main() -> int:
    text = WORKFLOW.read_text(encoding="utf-8")
    action_lines = [line.strip() for line in text.splitlines() if "uses:" in line]
    unfixed = [line for line in action_lines if not SHA_REF.fullmatch(line)]
    if unfixed:
        raise SystemExit("security-baseline contains unfixed Action refs: " + " | ".join(unfixed))
    required = (
        "permissions:\n  contents: read",
        "zricethezav/gitleaks:v8.30.1",
        "--log-opts=\"--all\"",
        "pull_request_target",
    )
    for fragment in required[:3]:
        if fragment not in text:
            raise SystemExit(f"security-baseline missing contract: {fragment}")
    if required[3] in text:
        raise SystemExit("pull_request_target is not allowed in the security baseline")
    print("workflow security contracts OK: fixed refs, read-only permissions, full-history gitleaks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
