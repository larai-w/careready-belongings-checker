#!/usr/bin/env python3
"""CareReadyの公開プロダクトデータを標準ライブラリだけで検証する。"""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data.json"
MIN_ITEMS = 28


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


def main() -> int:
    try:
        print(validate_data())
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
