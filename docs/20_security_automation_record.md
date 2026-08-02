# Security automation record

最終確認日: 2026-08-02

## 自動化している確認

- `security-baseline.yml`: 全履歴のgitleaksスキャン、Python依存パッケージ監査、週次実行、手動実行
- `scripts/check_public_repo.py`: 公開リポジトリ境界と秘密情報らしき内容
- `scripts/validate_workflow_security.py`: Security baselineの固定SHA、read-only権限、危険トリガー不使用
- pre-commit gitleaks: staged変更の秘密情報スキャン

gitleaksはNode.js Actionに依存せず、`zricethezav/gitleaks:v8.30.1`のCLIコンテナを実行する。監査出力に秘密情報を含めないため、`--redact`を必須にしている。

## 監査結果

- ローカル全履歴スキャン: 245コミット、leakなし
- Python依存監査: GitHub Actionsで成功
- 公開境界監査: 成功
- 未確認: GitHub Projectの実ボード状態（GitHub API障害時は監査スクリプトが未確認として終了）

このファイルには認証情報、AWS識別子、施設名、個人情報、raw scanner outputを記録しない。
