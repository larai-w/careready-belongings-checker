# 実機前の自動preflight

Issue #51の成果物。実機E2Eの前に、機械で確認できる項目を1コマンドで検査する。

## 実行

前提:

- Google Chrome
- Python依存を導入した`backend/.venv`
- `gitleaks`

```bash
bash scripts/run_human_gate_preflight.sh
```

Chromeが標準パスにない場合は`CHROME_BIN`を指定する。一時的に利用可能なlocalhost portを自動選択するため、通常はport指定不要。

## 自動確認する範囲

- 公開リポジトリ境界
- JavaScriptとJSONの構文
- データ、内容、製品、workflow security、accessibilityの契約
- GitHub Actions参照とローカル文書リンク
- backend test
- Git履歴のsecret scan
- headless Chrome smoke(現行CI基準のcheckbox 20件以上と主要UIラベル)
- 家族側`test-e2e.html`の`E2E_RESULT: ALL_PASS`

DOM、server log、Chrome profileは一時ディレクトリに置き、成功・失敗にかかわらず終了時に削除する。施設名、氏名、健康情報、認証情報、share code、本番データは使用しない。

## 自動化できないHuman gate

このpreflightがPASSでもIssue #6はcloseしない。次は[実機E2Eウォークスルー](15_実機E2Eウォークスルー.md)で以下を人間が確認する。

- 施設アカウントの実ブラウザsign-in
- dummy templateの作成とQR/code handover
- 実スマートフォンでの取込、機内モード保持、online復帰
- 準備、帰宅確認、状態トグルの視認性と操作性
- 実際のprint preview/output
- critical不具合0件と非機微な結果サマリ

## 判定

- `AUTOMATED PREFLIGHT: PASS`: 自動範囲のみ完了。Human gateはopen。
- 終了コード1: 実機確認へ進まず、表示された自動検査を修正する。

Chromeの実時間上限はsmoke 120秒、E2E 1試行180秒。仮想時間が進まない場合も無限待ちせず失敗する。

本番AWSへのdeploy、施設データ作成、本番認証情報の読取りは行わない。
