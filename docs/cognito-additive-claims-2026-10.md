# Cognito トークンへのクレーム追加(acr / amr)影響調査 — 2026-10

## 背景

AWS からの通知: **2026-11-04 以降、Amazon Cognito が発行するトークンに `acr`(文字列)と
`amr`(文字列の配列)が加わり、OIDC の設定(discovery)にも項目が加わる。決まった形の
トークン・設定しか受け付けない実装は失敗する可能性がある。**

この文書は、CareReady のコードで Cognito のトークン・クレーム・OIDC 設定を読んでいる箇所を
すべて洗い出し、「知らない項目があるとエラーにする」書き方がないかを確認した結果である。
調査はコード読解とユニットテストのみで行い、本番環境・AWS アカウントには触れていない。

## 結論

**修正が必要な箇所は見つからなかった。** どの経路も必要なクレームだけを名前で取り出し、
それ以外は無視する書き方になっている。追加クレームを含むイベントで動作を固定する回帰テストを
`backend/tests/test_cognito_claims.py` に追加した。

## 調査した箇所

| # | 場所 | Cognito との関わり | 知らない項目への挙動 | 判定 |
|---|---|---|---|---|
| 1 | API Gateway HTTP API の JWT オーソライザー<br>`backend/infra/stacks/careready_backend_stack.py`(`HttpUserPoolAuthorizer`) | `/v1/facility/templates*` の ID トークンを検証 | AWS 管理の検証。署名・`iss`・`aud`(client id)・`exp` 等のみを確認し、他のクレームは検証対象外。スコープ指定(`authorization_scopes`)も無し | 影響なし |
| 2 | Lambda `backend/src/handler.py` の `_facility_id()` | `requestContext.authorizer.jwt.claims` を読む | `custom:facilityId` → `sub` の順に `dict.get()` で取り出すだけ。クレームの一覧・型・件数の検証や、未知キーでの例外は無い | 影響なし |
| 3 | 施設管理画面 `admin/admin.js` の `login()` / `apiFetch()` | Cognito `InitiateAuth` を `fetch` で直接呼び、`AuthenticationResult.IdToken` を取得 | トークンは **不透明な文字列として保存・送信するだけ**(デコードしない)。レスポンス JSON も `ChallengeName` / `AuthenticationResult.IdToken` だけを参照し、他のキーは無視 | 影響なし |
| 4 | `lib/admin-template.js` の `mapLoginError()` | `InitiateAuth` のエラー `__type` を日本語化 | 既知の型以外は汎用メッセージにフォールバック | 影響なし |
| 5 | 家族向けフロント `app.js` / `lib/` / `sw.js` | **Cognito を使っていない**(`atob` は Web Push の VAPID 鍵と共有リンクのデコード用) | — | 対象外 |
| 6 | OIDC discovery(`/.well-known/openid-configuration`)の利用 | Hosted UI / ユーザープールドメイン / OAuth フローを **設定していない**。アプリ側で discovery 文書を取得・解析するコードも無い。discovery を読むのは API Gateway の JWT オーソライザー(AWS 管理)のみ | — | 影響なし |
| 7 | Cognito Lambda トリガー(Pre Token Generation 等) | **設定していない** | — | 対象外 |
| 8 | GitHub Actions の OIDC(`deploy*.yml`) | GitHub → AWS STS の OIDC であり Cognito とは無関係 | — | 対象外 |

### 補足: HTTP API が渡すクレームの形

HTTP API の JWT オーソライザーは、配列のクレームを Lambda へ **`"[pwd otp]"` のような文字列**
として渡す(`cognito:groups` と同じ扱い)。`amr` も同様になる見込みだが、handler は `amr` を
読まないため、配列・文字列どちらで来ても影響しない。テストでは両方の形を確認している。

## 追加したテスト

`backend/tests/test_cognito_claims.py`(`conftest.make_event()` に `extra_claims` 引数を追加):

- `custom:facilityId` 付きのイベントに `acr` / `amr`(配列・文字列・空)や将来の未知クレームを
  足しても、テンプレの作成・一覧取得が成功し、同じ施設スコープで読めること
- `sub` フォールバック経路でも同様に成功すること
- `acr` / `amr` だけでは識別子にならず、従来どおり 401 になること

## 今後同じ種類の変更に備えて(提案・未実施)

- 将来クレームを読む処理を足すときも、`dict.get()` で必要なキーだけを取り出す今の書き方を守る。
  JSON Schema 等で `additionalProperties: false` のような厳格な検証をトークンに掛けない。
- 管理画面で ID トークンをデコードする必要が出た場合も、未知のキーを無視する実装にする。
- 2026-11-04 以降、実機で管理画面にログインし、テンプレ一覧が表示されることを一度確認すると
  安心(本番操作のため人間が実施)。
