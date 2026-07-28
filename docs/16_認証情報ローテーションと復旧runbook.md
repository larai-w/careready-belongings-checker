# 認証情報ローテーションと復旧 Runbook(M1 安全確認 / Issue #7)

最終更新: 2026-07-28

## 目的

クローズドパイロット前に、施設スタッフ用 Cognito 認証情報を安全化(ローテーション)し、サインインと復旧手順を検証する。旧パスワードが過去の AI 作業ログに残っている可能性があるため、これは [12_一般公開マイルストーン.md](12_一般公開マイルストーン.md) の **M1 安全確認**ブロッカーである(Issue #7)。

**重要(公開ポリシー)**: この runbook は**手順のみ**を記す。実際のパスワード・トークン・アクセスコード・ユーザープール ID・メールアドレスなどの機微値は、このリポジトリにも chat 履歴にも一切書かない([PUBLIC_REPOSITORY_POLICY.md](PUBLIC_REPOSITORY_POLICY.md))。値はプレースホルダ(`<...>`)で示す。パスワード設定は owner が端末で直接、履歴に残さない形で行う。

## 前提: メールのサインインエイリアス vs Cognito 内部 Username(最重要)

このユーザープールは **ログイン入力はメールアドレス**(エイリアス)だが、Cognito 内部の `Username` は **UUID になることがある**。管理 CLI(`admin-set-user-password` など)は**内部 Username を対象**に実行する必要があり、メールアドレスをそのまま `--username` に渡すと対象ユーザーを取り違える/失敗することがある。

したがってローテーションは必ず次の順で行う:

1. `list-users` で対象ユーザーを**メールで検索し、内部 `Username`(UUID の可能性)を確認**する。
2. 確認した**内部 Username** を管理 CLI の `--username` に指定する。
3. サインインの動作確認は、ユーザーが実際に打つ**メールアドレス**(エイリアス)で行う。

この「管理操作=内部 Username / ログイン=メールエイリアス」の区別が Issue #7 の検証対象である。backend の開発セットアップ手順にも同趣旨の注記がある([backend/README.md](../backend/README.md) の「施設ユーザーの作成」節)。

## ローテーション手順(owner が端末で実施)

> 値は全てプレースホルダ。実値はシェル履歴に残さない配慮(`set +o history` 等)を owner の判断で行う。パスワードはこのファイル・PR・Issue・chat に**書かない**。

```bash
POOL_ID=<UserPoolId の値>          # 例: cdk Outputs の UserPoolId
REGION=ap-northeast-1

# 1) メールで対象を検索し、内部 Username を確認する
aws cognito-idp list-users \
  --user-pool-id "$POOL_ID" \
  --filter 'email = "<staff@example-facility.jp>"' \
  --region "$REGION"
# => 出力の "Username" を控える(UUID の場合あり)。以降 <INTERNAL_USERNAME> と記す。

# 2) 内部 Username を対象に、新しい恒久パスワードを設定する
#    パスワードは対話・別経路で安全に入力し、コマンド履歴に残さない。
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username <INTERNAL_USERNAME> \
  --password "<新しい一意の恒久パスワード>" \
  --permanent \
  --region "$REGION"
```

- 新パスワードは**一意で使い回さない**こと。旧パスワードは無効化される(`--permanent` で恒久設定)。
- パスワードを平文で残す場所を作らない(メモ・repo・chat・スクショ不可)。owner のパスワードマネージャ等、repo 外で管理する。

## サインイン検証(メールエイリアスで)

```bash
CLIENT_ID=<UserPoolClientId の値>

# ユーザーが実際に使うメールアドレスでの認証を確認する
aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=<staff@example-facility.jp>,PASSWORD='<新パスワード>' \
  --region ap-northeast-1
# => AuthenticationResult(IdToken 等)が返れば成功。
```

- CLI 認証が通ったら、**実ブラウザ `https://veai.jp/ready/` でも同じメール+新パスワードでサインインできる**ことを確認する(実機 E2E は [15_実機E2Eウォークスルー.md](15_実機E2Eウォークスルー.md) の手順1と同一)。
- HTTP API の Cognito オーソライザーは既定で **ID トークン**を検証する点に注意([backend/README.md](../backend/README.md))。

## 復旧(トラブル時)

| 事象 | 対処 |
|---|---|
| 新パスワードでサインインできない | `list-users` で `UserStatus` を確認。`FORCE_CHANGE_PASSWORD` なら `admin-set-user-password --permanent` を内部 Username に対して再実行 |
| どの Username が対象か分からない | 必ず `list-users --filter 'email = "..."'` で内部 Username を再特定してから操作する(メール直指定で操作しない) |
| 誤ってロックした/不整合 | ユーザーを削除して `admin-create-user` で再作成([backend/README.md](../backend/README.md) の管理者操作)。`custom:facilityId` を旧値に合わせるとテンプレのスコープが保たれる |
| パイロット停止が必要 | 一般公開 CTA を出していない前提のため影響は限定的。必要なら該当ユーザーを無効化し、原因を非公開領域に記録してから再開する |

## 完了記録(機微値を保存しない)

Issue #7 の Done when に対応。**パスワードや認証情報は記録しない**。

- [ ] 新しい一意の恒久パスワードを chat・repo 履歴の外で設定した
- [ ] メールでのブラウザサインインを検証した
- [ ] runbook がメールのサインインエイリアスと Cognito 内部 Username を区別していることを確認した(本 runbook「前提」節)
- [ ] パスワード等を保存せずに完了を記録した

完了日: **YYYY-MM-DD** / 実施者(GitHub 名): **larai-w**

> 完了したら Issue #7 に「ローテーション完了(日付)/ メールサインイン検証 OK / runbook 区別確認 OK」の**非機微な事実のみ**をコメントしてクローズする。パスワード・プール ID・メール・トークンは書かない。
