# CareReady — AIエージェント向け開発ガイド

介護(パーキンソン病患者の施設入所・ショートステイ)向け持ち物チェッカーPWA。
**全体像と作業履歴は `docs/07_作業ノート_引き継ぎ.md` を最初に読むこと。**

## プロジェクト構成

- **ビルドなし** Vanilla JS (ES Modules) + Tailwind CDN。npmもバンドラもない。導入しないこと
- `index.html`(マークアップ) / `app.js`(全ロジック) / `storage.js`(永続化) / `data.json`(持ち物データ) / `sw.js`(SW) / `admin/`(施設向け管理画面) / `backend/`(CDK + Lambda) / `docs/`(企画・設計・引き継ぎ)

## 必須の規約

1. **XSS**: 動的テキストは必ず `createElement` + `textContent`。`innerHTML` にデータを入れない(既存コード全体がこの方式)
2. **状態管理**: `storage.js` の `getState / setState / removeState` を使う(同期呼び出し可、IndexedDB非同期永続化+localStorageフォールバック)。直接 localStorage/IndexedDB を触らない
3. **sw.js**: フロントのファイルを変更したら `CACHE_NAME` を必ずバンプする(現在 `careready-v5`)。忘れると利用者に更新が配信されない
4. **オフラインファースト**: ネットワーク必須の機能を追加する場合も、既存機能がオフラインで動く性質を壊さない(介護施設・病院は電波が弱い)
5. UIテキストは日本語。ターゲットは50〜70代の家族介護者(高コントラスト・大きめタップ領域)

## 検証方法(コミット前に必ず)

```bash
node --check app.js && node --check storage.js && node --check sw.js
python3 -c "import json; json.load(open('data.json'))"

# ヘッドレスChromeスモークテスト(macOS)
python3 -m http.server 8000 --bind 127.0.0.1 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --virtual-time-budget=25000 --dump-dom http://127.0.0.1:8000/ > /tmp/dom.html
grep -o 'type="checkbox"' /tmp/dom.html | wc -l   # 28以上であること
# 注意: dumpは1行に圧縮される。grep -c ではなく grep -o | wc -l を使う
# 注意: 実ネットワーク/IndexedDBのIOはvirtual-timeで待てないことがある(描画0はタイミング問題の可能性)
```

バックエンド: `backend/.venv/bin/python -m pytest backend/tests/ -q`(9件)。CDK変更時は `npx aws-cdk@2 synth` まで。**`cdk deploy` は人間の確認を得てから**。

## デプロイ

`main` へのpushで GitHub Actions が自動実行: CI(上記スモークテスト) → S3 `veai-careready-frontend/ready/` 同期 + CloudFront無効化。手動デプロイ不要。本番: https://veai.jp/ready/

## 触ってはいけないもの

- DynamoDB `careready-main` / Cognito Pool(RETAIN指定の本番データ)を削除・再作成しない
- ルート README.md はポートフォリオ用途(英語・MSCS/PMP文脈)。スタイルを保って更新する
- 認証情報・パスワードをリポジトリに書かない(公開リポジトリ)
