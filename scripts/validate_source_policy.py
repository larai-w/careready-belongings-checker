#!/usr/bin/env python3
"""CareReadyのフロント実装規約とService Worker設定を検査する。"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JS_FILES = [
    ROOT / "app.js",
    ROOT / "admin" / "admin.js",
    ROOT / "lib" / "ocr-match.js",
    ROOT / "lib" / "share.js",
    ROOT / "lib" / "checklist.js",
]
STATE_PRIMITIVES = re.compile(r"\b(?:localStorage|indexedDB)\b")
INNER_HTML_ASSIGNMENT = re.compile(r"\.innerHTML\s*=")
REQUIRED_PRECACHE = {
    "./",
    "./index.html",
    "./app.js",
    "./storage.js",
    "./data.json",
    "./manifest.webmanifest",
}
FRONTEND_PATHS = {
    "index.html",
    "app.js",
    "storage.js",
    "data.json",
    "manifest.webmanifest",
    "sw.js",
    "admin/index.html",
    "admin/admin.js",
}
FRONTEND_PREFIXES = ("icons/", "lib/")


class ValidationError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def validate_xss_and_storage() -> list[str]:
    results: list[str] = []
    for path in JS_FILES:
        text = read(path)
        relative = path.relative_to(ROOT)
        require(
            not INNER_HTML_ASSIGNMENT.search(text),
            f"{relative}: innerHTMLへの代入は禁止です。createElement/textContentを使ってください",
        )
        require(
            not STATE_PRIMITIVES.search(text),
            f"{relative}: localStorage/IndexedDBを直接使わずstorage.jsを経由してください",
        )
        results.append(f"{relative}: XSS/storage policy OK")
    return results


def parse_cache_name(text: str) -> str:
    match = re.search(r"const\s+CACHE_NAME\s*=\s*['\"]([^'\"]+)['\"]", text)
    require(match is not None, "sw.js: CACHE_NAMEを取得できません")
    return match.group(1)


def parse_precache_urls(text: str) -> set[str]:
    match = re.search(r"const\s+PRECACHE_URLS\s*=\s*\[(.*?)\];", text, re.DOTALL)
    require(match is not None, "sw.js: PRECACHE_URLSを取得できません")
    return set(re.findall(r"['\"](\./[^'\"]*)['\"]", match.group(1)))


def validate_service_worker() -> str:
    text = read(ROOT / "sw.js")
    cache_name = parse_cache_name(text)
    urls = parse_precache_urls(text)
    missing = REQUIRED_PRECACHE - urls
    require(not missing, f"sw.js: 必須プリキャッシュが不足しています: {sorted(missing)}")

    for url in urls:
        if url == "./":
            continue
        path = ROOT / url.removeprefix("./")
        require(path.is_file(), f"sw.js: 存在しないファイルをプリキャッシュしています: {url}")
    return f"sw.js OK: {cache_name}, {len(urls)} precache entries"


def git_output(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout


def is_frontend_path(path: str) -> bool:
    return path in FRONTEND_PATHS or path.startswith(FRONTEND_PREFIXES)


def validate_cache_bump(base: str | None) -> str:
    if not base or set(base) == {"0"}:
        return "cache bump check skipped: comparison base is unavailable"

    try:
        changed = {
            line.strip()
            for line in git_output("diff", "--name-only", f"{base}...HEAD").splitlines()
            if line.strip()
        }
    except subprocess.CalledProcessError as error:
        raise ValidationError(f"git差分を取得できません: {error.stderr.strip()}") from error

    changed_frontend = sorted(path for path in changed if is_frontend_path(path))
    if not changed_frontend:
        return "cache bump OK: frontend files unchanged"

    try:
        previous_sw = git_output("show", f"{base}:sw.js")
    except subprocess.CalledProcessError:
        return "cache bump OK: sw.js did not exist at comparison base"

    current_name = parse_cache_name(read(ROOT / "sw.js"))
    previous_name = parse_cache_name(previous_sw)
    require(
        current_name != previous_name,
        "フロント変更時はsw.jsのCACHE_NAMEを更新してください: "
        + ", ".join(changed_frontend),
    )
    return f"cache bump OK: {previous_name} -> {current_name}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", help="CACHE_NAME更新を比較するGitコミット")
    args = parser.parse_args()
    try:
        for result in validate_xss_and_storage():
            print(result)
        print(validate_service_worker())
        print(validate_cache_bump(args.base))
    except (OSError, ValidationError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
