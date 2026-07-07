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
| `docs/` | 企画・戦略ドキュメント([目次](docs/README.md)) |

## 開発ロードマップ

[docs/02_開発戦略.md](docs/02_開発戦略.md) を参照。現在は **Phase 0(足場固め)** 完了段階。
