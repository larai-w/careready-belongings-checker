# CareReady ドキュメント

介護・入院・ショートステイの持ち物準備チェッカー「CareReady」の企画・開発ドキュメント。

| ファイル | 内容 |
|---|---|
| [01_開発スキルセット.md](01_開発スキルセット.md) | 現状分析と、開発に使う技術・スキル、推奨スタック |
| [04_ユーザーストーリー.md](04_ユーザーストーリー.md) | Epic別ユーザーストーリー+深掘り検討+MVP優先度 |
| [06_バックエンド設計書.md](06_バックエンド設計書.md) | 施設アカウント・マルチユーザー・DB(DynamoDB+Lambda)の設計。工数約24人日 |
| [08_持ち物コンテンツ設計_アーキテクチャ.md](08_持ち物コンテンツ設計_アーキテクチャ.md) | 製品・施設・個人の3層コンテンツ設計、デフォルト選定基準、現行アーキテクチャ図 |
| [13_product_management_case_study.md](13_product_management_case_study.md) | 英語PMケーススタディ。ユーザーストーリー、優先順位、リスク、コミット、未検証成果の証拠マップ |
| [14_github_project_operating_model.md](14_github_project_operating_model.md) | GitHub Issues / Projects の運用、自動化、Definition of Ready / Done、初期ライブバックログ |
| [15_実機E2Eウォークスルー.md](15_実機E2Eウォークスルー.md) | M1安全確認の施設サインインから家族側オフライン・帰宅確認・印刷までの実機手順と証拠テンプレ |
| [16_認証情報ローテーションと復旧runbook.md](16_認証情報ローテーションと復旧runbook.md) | 施設スタッフ認証情報の安全なローテーション、メールエイリアス、復旧、非機微な完了記録 |
| [17_運用・プライバシー・障害対応runbook.md](17_運用・プライバシー・障害対応runbook.md) | 家族・施設の問い合わせ経路、データ取扱い、停止基準、封じ込め、ロールバック |
| [18_facility_code_handover_observation_template.md](18_facility_code_handover_observation_template.md) | Issue #10の匿名化観察テンプレート |
| [19_product_decision_evidence_matrix.md](19_product_decision_evidence_matrix.md) | Issue #12の比較判断マトリクス |
| [20_security_automation_record.md](20_security_automation_record.md) | 公開可能なセキュリティ自動化と監査結果 |
| [21_release_evidence_checklist.md](21_release_evidence_checklist.md) | 技術検証と人間ゲートを分けた公開リリース証跡 |
| [Issue readiness audit](../scripts/audit_issue_readiness.py) | Open Issueの受け入れ条件と停滞期間を週次レポートする非破壊監査 |
| [Release evidence workflow](../.github/workflows/release-evidence.yml) | CI・Security・Deployの公開可能な実行証跡をartifact化 |
| [Project audit workflow](../.github/workflows/project-audit.yml) | ProjectのIssue/Status不整合を週次・手動監査 |
| [Data and link validators](../scripts/validate_data_contract.py) | 公開データ構造とMarkdownのローカルリンクをCIで検査 |

## 3行サマリー

1. **何を作るか**: 家族と施設の間の「持ち物準備」を確実にする介護特化チェッカー。差別化は施設ルール対応・帰宅時逆チェック・AI生成。
2. **どう広げるか**: 家族(B2C・無料)で実績を作り、施設(B2B・有料)へ入る2段ロケット。共有機能自体がバイラルループ。
3. **いくらかかるか**: 自社+AI開発なら実費 約5〜15万円/6ヶ月。外注ならフリーランス約250〜400万円、開発会社約900万円。
