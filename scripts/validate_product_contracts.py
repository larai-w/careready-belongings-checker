#!/usr/bin/env python3
"""CareReadyの公開フローと公開テンプレートの最低限の契約を検査する。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(text: str, fragment: str, source: str) -> None:
    if fragment not in text:
        raise SystemExit(f"{source}: required contract is missing: {fragment}")


def main() -> int:
    app = read("app.js")
    index = read("index.html")
    observation = read("docs/18_facility_code_handover_observation_template.md")
    decision = read("docs/19_product_decision_evidence_matrix.md")

    for fragment in (
        "isSpecialOuting(currentSubtype)",
        "addOutingStarterSet",
        "このおでかけに必要な持ち物を、ここから準備しましょう。",
        "encodeShareData",
        "handlePrint",
    ):
        require(app, fragment, "app.js")
    for fragment in ("special-modal", "特別なおでかけ", "share-btn", "print-btn"):
        require(index, fragment, "index.html")
    for fragment in ("Observation record", "Decision summary", "Issue #10", "anonymised"):
        require(observation, fragment, "docs/18_facility_code_handover_observation_template.md")
    for fragment in ("Options", "Evidence log", "Minimum decision gate", "Issue [#12]"):
        require(decision, fragment, "docs/19_product_decision_evidence_matrix.md")

    print("product contracts OK: outing flow, share/print, and public evidence templates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
