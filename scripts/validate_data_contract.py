#!/usr/bin/env python3
"""Validate the public checklist data shape and cross references."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise SystemExit(f"data.json contract error: {message}")


def unique_ids(values: list[dict], label: str) -> set[str]:
    ids: list[str] = []
    for value in values:
        item_id = value.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            fail(f"{label} has a missing id")
        ids.append(item_id)
    if len(ids) != len(set(ids)):
        fail(f"{label} contains duplicate ids")
    return set(ids)


def main() -> int:
    data = json.loads((ROOT / "data.json").read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        fail("root must be an object")
    conditions = data.get("conditions")
    locations = data.get("locations")
    categories = data.get("categories")
    if not all(isinstance(value, list) for value in (conditions, locations, categories)):
        fail("conditions, locations, and categories must be arrays")

    condition_ids = unique_ids(conditions, "conditions")
    location_ids = unique_ids(locations, "locations")
    category_ids = unique_ids(categories, "categories")
    item_ids: set[str] = set()
    item_count = 0

    for location in locations:
        if not isinstance(location.get("name"), str) or not location["name"].strip():
            fail(f"location {location['id']} has no name")
    for category in categories:
        if not isinstance(category.get("name"), str) or not category["name"].strip():
            fail(f"category {category['id']} has no name")
        items = category.get("items")
        if not isinstance(items, list) or not items:
            fail(f"category {category['id']} has no items")
        for item in items:
            item_count += 1
            current_ids = unique_ids([item], "items")
            if item_ids & current_ids:
                fail(f"items contains duplicate id: {item['id']}")
            item_ids.update(current_ids)
            if not isinstance(item.get("name"), str) or not item["name"].strip():
                fail(f"item {item['id']} has no name")
            applicable = item.get("applicable_locations")
            if not isinstance(applicable, list) or not applicable:
                fail(f"item {item['id']} has no applicable_locations")
            unknown_locations = set(applicable) - location_ids
            if unknown_locations:
                fail(f"item {item['id']} references unknown locations: {sorted(unknown_locations)}")
            condition = item.get("condition")
            if condition is not None and condition not in condition_ids:
                fail(f"item {item['id']} references unknown condition: {condition}")

    print(f"data contract OK: {len(location_ids)} locations, {len(category_ids)} categories, {item_count} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
