# CareReady バックエンド (ステップ B-1)

ショートステイ・入院・施設入所などのケア移行に伴う持ち物管理 PWA「CareReady」(本番: `veai.jp/ready/`)のバックエンド雛形。

設計は [`../docs/06_バックエンド設計書.md`](../docs/06_バックエンド設計書.md) を参照。本ディレクトリは **B-1**(DynamoDB + Lambda + API Gateway 雛形、`/templates/redeem` と施設テンプレ CRUD のみ)を実装する。

## 構成

```
backend/
├── infra/                 # AWS CDK v2 (Python)
│   ├── app.py             # CDK エントリポイント
│   ├── cdk.json
│   ├── requirements.txt   # CDK 用依存 (aws-cdk-lib, constructs)
│   └── stacks/
│       └── careready_backend_stack.py
├── src/
│   └── handler.py         # Lambda(単一関数 + 内部ルーター、依存は boto3 のみ)
├── tests/                 # pytest + moto
│   ├── conftest.py
│   └── test_handler.py
└── README.md
```

- **DynamoDB** `careready-main`: PK/SK(文字列)、GSI1(`GSI1PK`= `CODE#<shareCode>`、shareCode 解決用)、オンデマンド課金、`RemovalPolicy.RETAIN`
- **Lambda**: Python 3.12 単一関数。API Gateway は保持対象の発行済みバージョンを `prod` Alias 経由で呼び出す
- **監視**: API Lambda と予定リマインド Lambda のエラーを CloudWatch Alarm で検知し、既存の運用通知 SNS へ送る
- **API Gateway (HTTP API)**:
  - `POST /v1/templates/redeem`(公開)
  - `POST /v1/ocr/items`(公開、写真1枚のOCR候補抽出)
  - `GET/POST /v1/facility/templates`(Cognito JWT)
  - `GET/PUT/DELETE /v1/facility/templates/{tplId}`(Cognito JWT)
- **OCR**: OpenAI Vision API を既定プロバイダとして紙の持ち物リスト写真から候補を抽出。画像は保存せず、Lambda から同期処理する。`OCR_PROVIDER=textract` で Textract へ切替可能
- **Cognito**: 施設スタッフ用ユーザープール(メール+パスワード、**セルフサインアップ無効** = 管理者がユーザー作成)
- **CORS**: `https://veai.jp` と `http://localhost:8000`
- **スタック名**: `CareReadyBackendStack` / **リージョン**: `ap-northeast-1`

## セットアップ

```bash
# リポジトリルートで
python3 -m venv backend/.venv
source backend/.venv/bin/activate
pip install --prefer-binary aws-cdk-lib constructs pytest moto boto3
```

> 補足: 一部環境で `cryptography`(moto 依存)のソースビルドに失敗する場合は
> `pip install --only-binary=:all: cryptography` で先にホイールを入れてから残りを入れる。

## テスト

```bash
backend/.venv/bin/python -m pytest backend/tests/ -q
```

redeem のハッピーパス/404、施設テンプレ CRUD、入力バリデーション、facilityId フォールバックなどを検証する。

## デプロイ

CDK は仮想環境の Python(`aws_cdk` が入っている venv)を使う必要がある。`cdk.json` の `app` は `python3 app.py` なので、venv を有効化した状態で実行する。

```bash
cd backend/infra
source ../.venv/bin/activate

# 合成のみ(AWS 認証不要)
cdk synth --quiet
# または CDK CLI をローカルに入れていない場合
npx --yes aws-cdk@2 synth --quiet
python3 validate_template.py cdk.out/CareReadyBackendStack.template.json

# 初回のみ(アカウント×リージョンのブートストラップ)
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1

# デプロイ
cdk deploy
```

デプロイ後、Outputs に以下が出力される:

- `ApiUrl` — API のエンドポイント URL
- `ApiLambdaAliasArn` — API Gateway が呼び出す `prod` Alias の ARN
- `UserPoolId` — Cognito ユーザープール ID
- `UserPoolClientId` — アプリクライアント ID
- `TableName` — DynamoDB テーブル名(`careready-main`)

> 注意: 本番 AWS アカウントで運用中のため、`cdk deploy` の実行は事業側の判断で行うこと。

## Lambda の確認と緊急ロールバック

通常のリリースは CDK で新しい API Lambda バージョンを発行し、`prod` Alias をそのバージョンへ更新する。発行済みバージョンは保持される。

```bash
# 現在 prod が指すバージョンを確認
aws lambda get-alias \
  --function-name careready-api \
  --name prod \
  --query FunctionVersion \
  --output text \
  --region ap-northeast-1

# 発行済みバージョンを確認
aws lambda list-versions-by-function \
  --function-name careready-api \
  --query 'Versions[].Version' \
  --output table \
  --region ap-northeast-1
```

障害時は、直前に正常動作を確認した数値バージョンへ Alias を一時的に戻せる。実行前に担当者の承認を得て、対象バージョンの動作記録を確認する。

```bash
aws lambda update-alias \
  --function-name careready-api \
  --name prod \
  --function-version <PREVIOUS_VERSION> \
  --region ap-northeast-1
```

手動変更は CloudFormation の管理状態との差分になるため、復旧後は正常なコミットから CDK を再デプロイし、Alias とコードの対応を一致させる。DynamoDB と Cognito はロールバック操作の対象にしない。

## 施設ユーザーの作成(管理者操作)

セルフサインアップは無効なので、管理者が CLI でユーザーを作成する。`custom:facilityId` を付けると、その値でテンプレがスコープされる(未指定なら Cognito の `sub` が facilityId になる)。

> 注意: このユーザープールは **ログイン入力はメールアドレス**だが、Cognito 内部の `Username` は UUID になることがある。`admin-set-user-password` など管理 CLI は、必要に応じて `list-users` で確認した **内部 Username** を対象に実行すること。

```bash
POOL_ID=<UserPoolId の値>

# ユーザー作成(仮パスワードをメール送信)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username staff@example-facility.jp \
  --user-attributes Name=email,Value=staff@example-facility.jp \
                    Name=email_verified,Value=true \
                    Name=custom:facilityId,Value=fac-0001 \
  --region ap-northeast-1

# 恒久パスワードを設定(仮パスワードのリセット手順を省略する場合)
# 内部 Username が UUID の場合は、その値を指定する
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username <list-users で確認した Username> \
  --password 'ChangeMe!2026' \
  --permanent \
  --region ap-northeast-1
```

## 動作確認(curl)

### 1. JWT の取得(施設スタッフ)

```bash
CLIENT_ID=<UserPoolClientId の値>

TOKENS=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=staff@example-facility.jp,PASSWORD='ChangeMe!2026' \
  --region ap-northeast-1)

ID_TOKEN=$(echo "$TOKENS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AuthenticationResult"]["IdToken"])')
API=<ApiUrl の値>
```

> HTTP API の Cognito オーソライザーは既定で **ID トークン**(`aud`=クライアント ID)を検証する。`ID_TOKEN` を使うこと。

### 2. テンプレ作成(shareCode が払い出される)

```bash
curl -sS -X POST "$API/v1/facility/templates" \
  -H "authorization: $ID_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"入院準備リスト","facilityName":"○○病院","items":[{"name":"パジャマ"},{"name":"タオル"}]}'
# => {"tplId":"...","name":"入院準備リスト","shareCode":"ABC234",...}
```

### 3. 一覧 / 取得 / 更新 / 削除

```bash
curl -sS "$API/v1/facility/templates" -H "authorization: $ID_TOKEN"
curl -sS "$API/v1/facility/templates/<tplId>" -H "authorization: $ID_TOKEN"
curl -sS -X PUT "$API/v1/facility/templates/<tplId>" \
  -H "authorization: $ID_TOKEN" -H "content-type: application/json" \
  -d '{"name":"更新後","items":[{"name":"歯ブラシ"}]}'
curl -sS -X DELETE "$API/v1/facility/templates/<tplId>" -H "authorization: $ID_TOKEN"
```

### 4. shareCode でテンプレ取込(公開・家族側)

```bash
curl -sS -X POST "$API/v1/templates/redeem" \
  -H "content-type: application/json" \
  -d '{"code":"ABC234"}'
# => {"name":"入院準備リスト","items":[...],"overrides":{},"facilityName":"○○病院","shareCode":"ABC234"}
# 見つからなければ 404 {"error":"template not found"}
```

## API リファレンス(B-1)

| Method | Path | 認可 | 用途 |
|---|---|---|---|
| POST | `/v1/templates/redeem` | なし | `{"code":"..."}` → GSI1 で解決しテンプレ本体を返す(404 あり) |
| POST | `/v1/ocr/items` | なし | `{"imageBase64":"..."}` → OCR 候補を返す。画像保存なし、最大 4MB、既定 20 回/日/IP |
| GET | `/v1/facility/templates` | Cognito | 自施設テンプレ一覧 |
| POST | `/v1/facility/templates` | Cognito | テンプレ作成(6 文字 shareCode 自動生成) |
| GET | `/v1/facility/templates/{tplId}` | Cognito | テンプレ取得 |
| PUT | `/v1/facility/templates/{tplId}` | Cognito | テンプレ更新 |
| DELETE | `/v1/facility/templates/{tplId}` | Cognito | テンプレ削除 |

- shareCode は 6 文字の英大数字。紛らわしい `I / O / 0 / 1` は除外
- バリデーション: `name` 最大 100 字 / `items` 最大 200 件 / 各 item `name` 最大 100 字。違反時は 400 `{"error":"..."}`
- テンプレは facilityId(`custom:facilityId`、無ければ `sub`)でスコープ
- OCR は氏名・部屋番号などを写さない運用前提。候補抽出のみ行い、利用者が確認してからカスタム項目に追加する

## OCR 設定

日本語の施設プリントを想定するため、既定は OpenAI Vision API。API キーは Secrets Manager に保存し、リポジトリや Lambda 環境変数へ直接書かない。

```bash
aws secretsmanager create-secret \
  --name careready/openai-api-key \
  --secret-string '{"OPENAI_API_KEY":"<OpenAI API key>"}' \
  --region ap-northeast-1
```

主な環境変数:

- `OCR_PROVIDER`: `openai`(既定) または `textract`
- `OPENAI_OCR_MODEL`: 既定 `gpt-5.6-luna`
- `OPENAI_API_KEY_SECRET_ID`: 既定 `careready/openai-api-key`
- `OCR_DAILY_LIMIT`: 既定 `20`
- `TEXTRACT_REGION`: Textract 使用時のみ。既定 `us-east-1`
