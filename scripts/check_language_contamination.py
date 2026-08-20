#!/usr/bin/env python3
"""日本語文書に混入した想定外の文字体系を検出する。

AI は「それらしい」文字列を生成する過程で、意図しない言語の文字を
混ぜることがある。日本語の文書にキリル文字やハングルが1文字だけ
紛れ込んでも、目視では気づきにくい。

実際に起きたこと（2026-08-17〜19）:
  - 公開ブログの下書きに「электрон」が混入（コミット前に発見）
  - 「荷物」が「荷물」に（ハングル1文字）
  - 「経過」が「경과」に

検出対象は日本語文書に出るはずのない文字体系のみ。中国語（簡体字）は
漢字と区別できないため対象外。英数字・絵文字・記号は当然許容する。
"""
import re
import sys
import unicodedata
from pathlib import Path

# 日本語文書に現れるはずのない文字体系
SUSPECT = {
    "キリル文字": r"[Ѐ-ӿԀ-ԯ]",
    "ハングル":   r"[가-힯ᄀ-ᇿ㄰-㆏]",
    "アラビア文字": r"[؀-ۿ]",
    "タイ文字":   r"[฀-๿]",
    "デーヴァナーガリー": r"[ऀ-ॿ]",
    "ヘブライ文字": r"[֐-׿]",
}

def scan(path: Path):
    """1ファイルを走査し、(行番号, 種別, 該当文字, 前後の文脈) を返す。"""
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, OSError):
        return []                      # バイナリ・読めないものは対象外
    hits = []
    for lineno, line in enumerate(text.split("\n"), 1):
        for name, pattern in SUSPECT.items():
            # 連続する文字はまとめて1件として報告する。1文字ずつ出すと
            # 「электрон」だけで8件になり、本当の件数が分からなくなる。
            for m in re.finditer(f"(?:{pattern})+", line):
                run = m.group(0)
                start = max(0, m.start() - 12)
                context = line[start:m.end() + 12]
                hits.append((lineno, name, run, unicodedata.name(run[0], "?"), context))
    return hits

def load_ignore(root: Path):
    """.langcheckignore を読む。1行1パターン（glob）。# はコメント。

    検査器自身や、混入事例を記載した文書には当然その文字が含まれる。
    除外できないと、正しく動く検査器ほど自分を止めてしまう。
    """
    f = root / ".langcheckignore"
    if not f.exists():
        return []
    return [
        line.strip()
        for line in f.read_text(encoding="utf-8").split("\n")
        if line.strip() and not line.lstrip().startswith("#")
    ]


def main(argv):
    paths = [Path(a) for a in argv if not a.startswith("-")]
    if not paths:
        print(__doc__)
        return 2
    patterns = load_ignore(Path.cwd())
    total = 0
    skipped = 0
    for p in paths:
        if not p.is_file():
            continue
        if any(p.match(pat) or str(p).startswith(pat.rstrip("*")) for pat in patterns):
            skipped += 1
            continue
        for lineno, name, ch, uname, context in scan(p):
            total += 1
            print(f"{p}:{lineno}: {name} '{ch}' ({uname})")
            print(f"    …{context}…")
    if skipped:
        print(f"（.langcheckignore により {skipped} ファイルを除外）")
    if total:
        print(f"\n❌ 想定外の文字体系を {total} 件検出しました。")
        print("   AI が生成した文字列に別言語が紛れている可能性があります。")
        print("   意図的なら .langcheckignore に該当ファイルを追加してください。")
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
