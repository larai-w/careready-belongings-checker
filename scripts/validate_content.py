#!/usr/bin/env python3
"""CareReadyの持ち物データと未公開記事を標準ライブラリだけで検証する。"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data.json"
DRAFT_DIR = ROOT / "docs" / "blog_drafts"
MIN_ITEMS = 28
PUBLIC_APP_URL = "https://veai.jp/ready/"

REQUIRED_FRONTMATTER = {
    "title",
    "description",
    "pubDate",
    "author",
    "tags",
    "lang",
}

FORBIDDEN_HEALTH_CLAIMS = {
    r"100\s*%": "絶対性能の表現",
    r"症状を治療": "治療効果の表現",
    r"病気を診断": "診断機能の表現",
    r"症状を予防でき": "予防効果の表現",
    r"完全に(?:忘れ物|紛失|事故)を防": "絶対的な予防表現",
}


class ValidationError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def unique_ids(entries: list[dict], label: str) -> set[str]:
    values = [entry.get("id") for entry in entries]
    require(all(isinstance(value, str) and value for value in values), f"{label}: idが不正です")
    require(len(values) == len(set(values)), f"{label}: idが重複しています")
    return set(values)


def validate_data() -> str:
    with DATA_PATH.open(encoding="utf-8") as handle:
        data = json.load(handle)

    locations = data.get("locations")
    conditions = data.get("conditions", [])
    categories = data.get("categories")
    require(isinstance(locations, list) and locations, "locationsが空または不正です")
    require(isinstance(conditions, list), "conditionsが不正です")
    require(isinstance(categories, list) and categories, "categoriesが空または不正です")

    location_ids = unique_ids(locations, "locations")
    condition_ids = unique_ids(conditions, "conditions")
    unique_ids(categories, "categories")

    for condition in conditions:
        require(isinstance(condition.get("name"), str) and condition["name"], "conditionのnameが不正です")
        require(isinstance(condition.get("default"), bool), f"condition {condition.get('id')}: defaultはbool必須です")

    items: list[dict] = []
    for category in categories:
        require(isinstance(category.get("name"), str) and category["name"], f"category {category.get('id')}: nameが不正です")
        category_items = category.get("items")
        require(isinstance(category_items, list), f"category {category.get('id')}: itemsが不正です")
        items.extend(category_items)

    unique_ids(items, "items")
    require(len(items) >= MIN_ITEMS, f"持ち物が{MIN_ITEMS}件未満です: {len(items)}")

    for item in items:
        item_id = item.get("id")
        require(isinstance(item.get("name"), str) and item["name"].strip(), f"item {item_id}: nameが不正です")
        applicable = item.get("applicable_locations")
        require(isinstance(applicable, list) and applicable, f"item {item_id}: applicable_locationsが空または不正です")
        unknown_locations = set(applicable) - location_ids
        require(not unknown_locations, f"item {item_id}: 未定義の用途 {sorted(unknown_locations)}")
        condition = item.get("condition")
        require(not condition or condition in condition_ids, f"item {item_id}: 未定義の条件 {condition}")

    return (
        f"data.json OK: {len(categories)} categories, {len(items)} items, "
        f"{len(locations)} locations, {len(conditions)} conditions"
    )


def parse_frontmatter(path: Path, text: str) -> tuple[dict[str, str], str]:
    match = re.match(r"\A---\s*\n(.*?)\n---\s*\n(.*)\Z", text, re.DOTALL)
    require(match is not None, f"{path.name}: frontmatterがありません")
    raw_frontmatter, body = match.groups()
    fields: dict[str, str] = {}
    for line in raw_frontmatter.splitlines():
        field = re.match(r"^([A-Za-z][A-Za-z0-9]*):\s*(.+)$", line)
        if field:
            fields[field.group(1)] = field.group(2).strip()
    return fields, body


def validate_draft(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    fields, body = parse_frontmatter(path, text)
    missing = REQUIRED_FRONTMATTER - fields.keys()
    require(not missing, f"{path.name}: frontmatterの必須項目不足 {sorted(missing)}")
    require(fields["lang"].strip("'\"") == "ja", f"{path.name}: langはja必須です")
    require(len(fields["title"].strip("'\"")) >= 10, f"{path.name}: titleが短すぎます")
    require(len(fields["description"].strip("'\"")) >= 40, f"{path.name}: descriptionが短すぎます")
    require(body.strip(), f"{path.name}: 本文が空です")
    require(len(re.findall(r"^##\s+", body, re.MULTILINE)) >= 2, f"{path.name}: H2が2件未満です")
    require(PUBLIC_APP_URL not in text, f"{path.name}: クローズドパイロット中の公開PWA CTAがあります")

    for pattern, label in FORBIDDEN_HEALTH_CLAIMS.items():
        require(not re.search(pattern, text, re.IGNORECASE), f"{path.name}: {label}を検出しました")

    warnings: list[str] = []
    if "YYYY-MM-DD" in fields["pubDate"]:
        warnings.append(f"{path.name}: 公開日は未設定（ドラフトのため許容）")
    return warnings


def validate_drafts() -> tuple[str, list[str]]:
    paths = sorted(DRAFT_DIR.glob("[0-9][0-9]_*.md"))
    require(paths, "未公開記事がありません")
    warnings: list[str] = []
    for path in paths:
        warnings.extend(validate_draft(path))
    return f"blog drafts OK: {len(paths)} files", warnings


def main() -> int:
    try:
        print(validate_data())
        draft_result, warnings = validate_drafts()
        print(draft_result)
        for warning in warnings:
            print(f"WARNING: {warning}")
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
