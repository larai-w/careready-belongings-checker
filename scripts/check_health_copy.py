#!/usr/bin/env python3
"""薬機法・医療広告ガイドラインの疑わしい表現を警告する（DELAY レベル）。

使い方: python3 setup/check_health_copy.py <file> [<file> ...]

**これは BLOCK ではなく DELAY。** 見つけても終了コード 0 を返す。
理由: 「改善」は「症状が改善する」なら違反だが「操作性を改善した」は問題ない。
文脈で正誤が変わるものを機械が断定して止めると、迂回されるようになる。

判断の根拠: veai-jp-web/docs/health-copy-guidelines.md
"""
import re
import sys
from pathlib import Path

# 症状・病気を指す語。効果を主張する動詞と近ければ薬機法の領域に入る。
SUBJECT = r"(症状|病気|疾患|発作|痛み|不調|転倒|認知症|パーキンソン|便秘|うつ|不眠)"

# 効果を主張する動詞。「治療」「主治医」に当たらないよう語尾まで指定する。
# 「治」だけにすると免責文の「診断・治療を行うものではありません」を拾ってしまう。
CURE = r"(治(る|り|し(ます|た)|せ|癒)|改善(し|す|さ|で)|緩和(し|す|さ)|軽減(し|す|さ)|解消(し|す|さ))"

RULES = [
    (rf"{SUBJECT}[^。\n]{{0,12}}(が|を|の)?[^。\n]{{0,8}}{CURE}",
     "治療効果の主張に読める", "「記録を整理し、気づきを得やすくします」のように活動を述べる"),
    (rf"{SUBJECT}[^。\n]{{0,12}}(を|の)?[^。\n]{{0,8}}(予防(し|す|で|さ)|防止(し|す|で)|防ぎ|防げ)",
     "予防効果の主張", "「備えを助けます」等、断定しない表現に"),
    (rf"{SUBJECT}[^。\n]{{0,12}}(を|の)?[^。\n]{{0,8}}(検知(し|す|さ)|診断(し|す|さ)|判定(し|す|さ)|判別(し|す|さ))",
     "診断機能の主張", "「記録します」「共有します」に"),
    # 「100%」単体は違反ではない（「100% of the time」「no forced 100%」）。
    # 正確さ・安全性・効果の主張と結びついたときに薬機法の領域に入る。
    (r"(?<![0-9.])100\s*[%％][^。\n]{0,10}(正確|安全|確実|防げ|効|信頼|accurate|safe|effective|reliable)"
     r"|(正確|安全|確実|信頼)(性|に|な)?[^。\n]{0,6}100\s*[%％]",
     "絶対的性能の保証", "範囲を限定した数値に"),
    (r"完全に(防|治|把握|管理)", "絶対的性能の保証", "「〜しやすくします」に"),
    (r"(必ず|絶対に)[^。\n]{0,4}(治(る|り|せ)|改善|防げ|効き)", "効果の保証", "断定を外す"),
    (r"\b(flawless|error-free|clinical-grade|medical-grade)\b",
     "絶対的性能・医療機器を思わせる語", "描写を具体的な機能に置き換える"),
    (r"\bproven\b[^.,\n]{0,25}\b(effective|safe|cure|treat|improv|health|outcome|result)"
     r"|\b(effective|safe|health|clinical)\w*\s+\w{0,12}\s?\bproven\b",
     "証明したという主張", "suggesting / in our own pilot data に"),
    (rf"\b(cures?|treats?|diagnoses?|prevents?)\b[^.\n]{{0,30}}\b(symptom|disease|illness|fall|seizure)",
     "治療・診断・予防の主張", "record / organize / share に言い換える"),
]

# 生成物は対象外。Lighthouse レポートの「100%」を薬機法で指摘しても意味がない。
SKIP_DIRS = {".git", "node_modules", ".venv", "dist", "build", ".next", "cdk.out",
             ".lighthouseci", "worktrees", "coverage", "playwright-report",
             "test-results", ".astro"}

# 「100%」等が健康と無関係に使われる文脈。ここに当たる行は数値ルールを飛ばす。
TECH_CONTEXT = re.compile(
    r"(カバレッジ|coverage|完成|達成|進捗|テスト|合格|還元|オフ|OFF|"
    r"充電|バッテリー|CPU|メモリ|再現|一致|通過)", re.IGNORECASE)
NUMERIC_RULE_IDX = 3

# 否定文は違反ではなく、むしろ必要な免責。
# 「病気の診断・治療を行うものではありません」を違反として挙げるのは逆。
NEGATION = re.compile(
    r"(ではありませ|ではない|ものではあり|しません|しない|代替(しま|せ)|"
    r"行うもので|保証(しませ|せず|は行)|意図(していま|しない)|"
    r"does not|do not|is not|are not|cannot|never|nor\s|"
    r"should not|must not|will not|would not|not intended|not be)", re.IGNORECASE)

# 「禁止表現を除去した」と書いている記録は、違反ではなく修正の記録。
# ガイドラインや worklog が自分の対象になると、直した人ほど警告される。
META_DISCUSSION = re.compile(
    r"(除去|削除|修正(し|済|した)|禁止|避け|置き換え|言い換え|NG|使わない|"
    r"prohibited|forbidden|avoid|replaced|removed|instead of)")

# CSS/コードの行。100% の大半は width や gradient。
CODE_LINE = re.compile(
    r"(\{|\}|;\s*$|calc\(|linear-gradient|translate|:\s*-?[0-9.]+(px|%|em|rem|vh|vw)|"
    r"@keyframes|var\(--|className=|style=)")

# 「100%」「proven」等の絶対表現は、それ自体では違反ではない。
# 「100% 親が再実行」「テストで proven」は薬機法と無関係。
# 健康・製品効能の文脈にあるときだけ指摘する。
HEALTH_CONTEXT = re.compile(
    r"(症状|病気|疾患|発作|痛み|不調|転倒|認知症|パーキンソン|便秘|服薬|薬|"
    r"健康|医療|診断|治療|介護|看護|患者|高齢|検査|効果|安全性|"
    r"symptom|disease|illness|patient|medic|health|care|clinical|diagnos|treat)",
    re.IGNORECASE)
# 文脈を要求する（＝それ単体では意味を持たない）ルールの index
CONTEXT_REQUIRED = {3, 6, 7}
# ファイル全体で健康語がこの数以上あれば「健康文脈の文書」とみなす。
# 行単位で判定すると「100% 正確に記録します」（前後の行に症状の話がある）を
# 取り逃がす。逆にファイル単位だけだと開発ブログを拾う。両方を使う。
HEALTH_FILE_THRESHOLD = 3


def load_ignore(root: Path):
    f = root / ".healthcopyignore"
    if not f.exists():
        return []
    return [l.strip() for l in f.read_text(encoding="utf-8").split("\n")
            if l.strip() and not l.lstrip().startswith("#")]


def scan(path: Path):
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []
    health_doc = len(HEALTH_CONTEXT.findall(text)) >= HEALTH_FILE_THRESHOLD
    hits = []
    for lineno, line in enumerate(text.split("\n"), 1):
        for idx, (pattern, why, hint) in enumerate(RULES):
            m = re.search(pattern, line, re.IGNORECASE)
            if not m:
                continue
            if pattern.endswith("[%％]") and (TECH_CONTEXT.search(line) or CODE_LINE.search(line)):
                continue  # CSS の width:100% や カバレッジ100% は薬機法の対象外
            if idx in CONTEXT_REQUIRED and not (health_doc or HEALTH_CONTEXT.search(line)):
                continue  # 絶対表現は健康文脈にあるときだけ問題になる
            # 否定を伴う文（免責文言）は違反ではない。前後どちらも見る。
            # 否定語は文頭近くに来ることが多い（「〜すべきではない…proven」）。
            # 文単位で見ないと免責文言を違反として拾う。
            start = max(line.rfind("。", 0, m.start()), line.rfind(". ", 0, m.start()), 0)
            end = line.find("。", m.end())
            window = line[start:end if end > 0 else min(len(line), m.end() + 80)]
            if NEGATION.search(window) or META_DISCUSSION.search(line):
                continue
            if True:
                hits.append((lineno, m.group(0).strip()[:60], why, hint))
                break  # 1行1件でよい。同じ箇所を何度も出さない
    return hits


def main(argv):
    paths = [Path(a) for a in argv if not a.startswith("-")]
    if not paths:
        print(__doc__)
        return 2
    patterns = load_ignore(Path.cwd())
    total = 0
    for p in paths:
        if not p.is_file() or any(d in p.parts for d in SKIP_DIRS):
            continue
        if any(p.match(pat) or str(p).startswith(pat.rstrip("*")) for pat in patterns):
            continue
        hits = scan(p)
        if hits:
            print(f"\n⚠️  {p}")
            for lineno, snippet, why, hint in hits:
                print(f"   {lineno}: 「{snippet}」")
                print(f"       {why} → {hint}")
            total += len(hits)

    if total:
        print(f"\n⚠️  薬機法の観点で確認したい箇所が {total} 件あります。")
        print("   これは警告です。コミットは止めません。")
        print("   文脈上問題なければそのまま進めてください（例: 「操作性を改善」は対象外）。")
        print("   判断基準: veai-jp-web/docs/health-copy-guidelines.md")
    return 0  # DELAY: 常に 0。止めない。


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
