# CareReady // 持ち物チェッカー

介護・入院・ショートステイの持ち物準備を確実にするチェックリストアプリ(PWA)。

<img src="icons/icon-192.png" width="80" alt="CareReady logo">

## 機能

- 📋 行き先(ショートステイ / 入院 / デイサービス)別の持ち物リスト
- 📦 コンテナ(箱)別ソート — どの荷物をどの箱に入れたか記録
- ✅ チェック状態・不要設定・箱割り当ての永続化(IndexedDB)
- 📶 オフライン対応(Service Worker)・ホーム画面追加対応(PWA)
- 🔄 API接続失敗時は前回キャッシュ → 同梱データの順で自動フォールバック

## 起動方法

ES Modules と Service Worker を使うため、ローカルサーバー経由で開く(`file://` 直接は不可):

```bash
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

## API接続

`app.js` 冒頭の `API_URL` を設定すると、サーバーからチェックリスト定義を取得する。
空文字のままなら同梱の `data.json` を使用する。

```js
const API_URL = 'https://veai.jp/api/checklist';
```

レスポンス形式は `data.json` と同じ:

```jsonc
{
  "locations":  [{ "id": "shortstay", "name": "ショートステイ" }],
  "categories": [{
    "id": "clothing",
    "name": "👕 衣類",
    "items": [{ "id": "cloth_top_bottom", "name": "着替え上下", "applicable_locations": ["shortstay"] }]
  }]
}
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | UI(マークアップのみ) |
| `app.js` | アプリロジック(描画・状態変更・データ取得) |
| `storage.js` | IndexedDB永続化レイヤー(旧localStorageデータは自動移行) |
| `data.json` | 標準持ち物リスト(APIフォールバック兼デフォルトデータ) |
| `sw.js` | Service Worker(オフラインキャッシュ) |
| `manifest.webmanifest` | PWAマニフェスト |
| `privacy.html` | 利用者向けのデータ取扱い・削除範囲・問い合わせ先 |
| `docs/` | 企画・戦略ドキュメント([目次](README.md)) |

## 開発ロードマップ

開発順序はGitHub Projectの公開バックログとIssueの受け入れ条件を参照する。

## 準備データのバックアップ

画面上部の「準備データの保存・復元へ」から、version 1のJSONバックアップを保存・復元できる。復元は対象の準備データを置き換える方式で、確認画面から取り消せる。元に戻すには置き換え前のバックアップが必要。

- 対象: 持ち物、準備・帰宅チェック、入れ物と割り当て、条件、予定、施設テンプレート、準備用の表示モード等。
- 対象外: 日記・写真・本人名・自由メモ・通知設定等。復元先のこれらの内容も維持する。
- 最大2MB。形式・版・値の型を確認後、IndexedDBの一つのtransactionで確認時の値と比較して保存する。localStorageのみの環境では一括復元を実行しない。
- `lib/backup.js` が形式、`lib/backup-ui.js` が画面、`storage.js` が永続値の取得・一括復元を担当する。

追加ブラウザ検証は既存のPlaywright環境を引数で渡して実行する。このrepoへのnpm・バンドラ導入は不要。

```sh
node tests/backup.browser.cjs /path/to/playwright
node tests/storage-share.browser.cjs /path/to/playwright
# Tailwind CDNスクリプトの取得済みコピーを第3引数に指定。
# 実SWを使い、外部応答はそのコピーで再現。他の外部通信は遮断する。
node tests/backup-offline.browser.cjs /path/to/playwright /path/to/tailwind-runtime.js
```

オフライン検証ではローカルHEADを旧版、作業ツリーを新版として別キャッシュ名で配信する。初回保存、再訪時更新、不完全な配信、元データと他アプリのキャッシュの保全を確認する。本番配信の検証とは区別する。

ブラウザテストは `CAREREADY_TEST_BROWSER=webkit` でも実行できる（既定はchromium）。WebKitではCSPの `upgrade-insecure-requests` に合わせ、HTTPSのテストサーバーを使う。`CAREREADY_TEST_TLS_DIR` に一時的な自己署名証明書 `cert.pem` と `key.pem` のあるフォルダを指定する。証明書の検証省略はこのテスト用contextのみで、OSの信頼設定やアプリのCSPは変更しない。鍵・証明書をrepoへ追加しない。

```sh
CAREREADY_TEST_BROWSER=webkit CAREREADY_TEST_TLS_DIR=/path/to/test-tls \
  node tests/backup.browser.cjs /path/to/playwright
```

オフライン試験の既定はブラウザのオフライン切替。`CAREREADY_TEST_OFFLINE_MODE=network-failure` を明示すると、ローカルサーバーがソケットを切断し、CDN応答も遮断する方式を使う。この場合 `navigator.onLine` は変更しない。エンジン名と方式を結果に表示する。WebKitの自動オフライン切替で内部エラーが発生した場合も、自動で成功扱いに切り替えず、別試験として実行・記録する。

## 準備の操作フロー

持ち物の追加は標準のdialogを使用。カテゴリー等にフォーカスがあってもEscで取り消せ、背景の操作を抑止する。内容が画面の高さを超える場合はダイアログ内をスクロールする。

```sh
node tests/preparation.browser.cjs /path/to/playwright /path/to/tailwind-runtime.js
```

初回案内、デイサービス選択、持ち物追加、数量変更、入れ物追加、詰める・取り出す、再読み込み後の保持とキーボード操作を確認。取得済みTailwindを応答に使い、その他の外部通信を遮断。人による使いやすさの評価や実機確認を代替しない。
