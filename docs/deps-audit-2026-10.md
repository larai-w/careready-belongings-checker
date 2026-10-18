# 依存パッケージ監査 — 2026-10

調査日: 2026-10-18。対象は Python(`backend/`・`backend/infra/`・`backend/push_sender/`)、
CDK、フロントエンドの JS(CDN 読み込み)。本番環境・AWS には触れていない。

## 調べ方

- 既知の脆弱性: 各 requirements / lock を `pip-audit -r <file>`(PyPI / OSV の公開アドバイザリ)で検査
- 依存の整合性: 新しい venv に lock を入れて `pip check`、CDK は `aws-cdk-lib` の `Requires-Dist` を確認
- Dependabot: 開いている PR を一覧化(GitHub の Dependabot alerts 画面はこの調査の手段では読めなかったため、
  リポジトリの Security タブで一度確認してほしい)
- JS: npm 依存は無い(ビルド無し構成)。HTML/JS から読み込む CDN の URL を確認

## 結果の要約

- **既知の脆弱性: 見つからなかった**(`backend/requirements-test.lock.txt`、更新後の
  `backend/infra/requirements.lock.txt`、`backend/push_sender/requirements.txt` のいずれも
  "No known vulnerabilities found")。
- **`backend/infra/requirements.lock.txt` がそのままではインストールできない状態だった。**
  `aws-cdk-lib` は `aws-cdk.asset-awscli-v1==2.2.292` を固定で要求するが、lock は 2.2.295 だった
  (Dependabot が 1 パッケージずつ上げた結果)。`constructs` も `requirements.txt` の下限(>=10.8.1)を
  lock(10.6.0)が満たしていなかった。CI は lock ではなく `requirements.txt` から入れているため
  気づかれていなかった。→ `chore/deps-2026-10` で修正。
- `backend/requirements-test.lock.txt` も、`boto3==1.43.46` が `requirements-test.txt` の下限
  (>=1.43.59)を下回り、`moto[dynamodb]` が必要とする `docker` / `py-partiql-parser` が抜けていた。
  → 同じブランチで修正。

## 分類

### 直す(小さく安全)— `chore/deps-2026-10` で対応

| 対象 | 変更 | 関連 Dependabot PR | 確認 |
|---|---|---|---|
| `aws-cdk-lib`(infra) | 2.272.0 → 2.273.0、`requirements.txt` の下限も 2.273.0 に | #125, #124(同内容の重複) | synth 後のテンプレートのリソースが 2.272.0 と完全一致 |
| `aws-cdk.asset-awscli-v1`(infra) | 2.2.295 → 2.2.292(`aws-cdk-lib` の固定要求に合わせる) | — | `pip check` OK |
| `constructs`(infra) | 10.6.0 → 10.8.1(`requirements.txt` の下限に合わせる) | — | `pip check` OK |
| `boto3` / `botocore`(infra・test) | infra 1.43.108 → 1.43.114、test 1.43.46 / 1.43.103 → 1.43.114 | #122, #123, #126 | pytest 36 件成功 |
| `charset-normalizer`(test) | 3.5.1 → 3.5.2 | #127 | pytest 36 件成功 |
| `docker` / `py-partiql-parser`(test) | lock に追記(`moto[dynamodb]` の依存の抜け) | — | `pip check` OK |

マージ後、#122〜#127 は Dependabot が自動で閉じる見込み(閉じなければ手動で close)。

### 直す(大きい)— 今回は対応せず、別途判断

1. **`pywebpush` を 2.x 前提にする(#119)**
   - `backend/push_sender/requirements.txt` は `pywebpush>=1.14.0` の下限だけで lock が無く、デプロイ時の
     バンドルで最新版(現在 2.5.0)が入る。つまり本番は既に 2.x になっている可能性が高いが、送信処理の
     自動テストが無い。
   - 提案: push_sender にも lock を作って版を固定し、`webpush()` 呼び出しのユニットテスト(モック)を
     足したうえで #119 を取り込む。動作確認は検証用の購読で実際に 1 通送る(人間が実施)。
2. **CI を lock ファイルから入れるようにする**
   - `backend-infra-ci.yml` は `requirements.txt` から入れているため、lock が壊れても CI が緑のまま。
     lock から入れる、または `pip install -r requirements.lock.txt && pip check` を足すと今回のような
     ずれを検出できる。ワークフロー変更なので別 PR で。
3. **Dependabot 設定の整理**
   - `directory: /backend` の pip 設定が `backend/infra/` の lock も拾い、`/backend/infra` 設定と
     同じ更新 PR が二重に出ている(#124 と #125、#88 と #81)。
   - `aws-cdk-lib` が固定・上限で縛る依存(`aws-cdk.asset-awscli-v1`、`aws-cdk.cloud-assembly-schema`、
     jsii が固定する `typeguard`)を単独で上げる PR は lock を壊すので、`ignore` するか、
     `aws-cdk-lib` と同じ group にまとめる。
4. **CDN 読み込みの版固定・SRI**(既知の脆弱性ではなく、供給網の堅牢化)
   - `admin/index.html` の `https://cdn.jsdelivr.net/npm/qrcode@1/...` はメジャー版のみ指定、
     Tailwind の CDN は版指定なし。いずれも `integrity` 属性が無い。
   - 完全な版固定 + SRI にすると、`sw.js` のプリキャッシュや CSP、表示の確認が必要になるため別 PR で。
5. **CDK の非推奨 API**
   - synth 時に `TableOptions#pointInTimeRecovery` が非推奨と警告される
     (`pointInTimeRecoverySpecification` へ移行)。本番テーブル(RETAIN)の定義に関わるため、
     テンプレート差分を確認してから別 PR で。
   - CI / ローカルの CDK CLI は `npx aws-cdk@2`(メジャー版のみ指定)。必要なら版を固定する。

### 影響なし・適用できない(閉じてよい)

| Dependabot PR | 内容 | 理由 |
|---|---|---|
| #121 | `aws-cdk.cloud-assembly-schema` 54.26.0 → 55.0.0 | `aws-cdk-lib` 2.272 / 2.273 とも `<55.0.0` を要求するため入れられない。`aws-cdk-lib` 側が対応したら自然に上がる |
| #81, #88 | `typeguard` 2.13.3 → 4.6.0 | `jsii` 1.140 が `typeguard==2.13.3` を固定で要求するため入れられない。CDK 合成時のみ使う開発依存で、既知の脆弱性も無い |

## 検証(`chore/deps-2026-10`)

- `backend/.venv/bin/python -m pytest backend/tests/ -q` → 36 passed(新しい test lock から作った venv)
- `pip check`(infra / test の両 venv)→ No broken requirements found
- CDK synth → 成功。`validate_template.py`(セキュリティ契約)OK、Golden Path レポート OK
  - この調査環境では Docker が使えないため、push_sender のアセットのバンドル(Docker 内の
    `pip install`)だけは省いて synth した。テンプレート本体は生成・検証済み。バンドル込みの synth は
    PR の CI(`Backend infrastructure CI`)で実行される。
- synth 結果を `aws-cdk-lib` 2.272.0 と比べ、リソースの追加・削除・変更が無いことを確認
- `pip-audit` → 既知の脆弱性なし
