"""毎日1回動く Web Push 送信 Lambda。

予定日は保存していないので、payload なしの「確認プッシュ」を全購読へ送るだけ。
通知するか/内容は 各端末の Service Worker が端末内データを見て決める。

1件の失敗で他を止めないため、送信の失敗は握って続ける。ただし握ったときは
必ず grep できる印（`[PUSH SEND FAILED]` / `[PUSH SUB SKIPPED]`）をログに残し、
件数を戻り値に入れる。印が無いと、全件失敗しても Lambda の Errors は 0 のままで
アラームに映らない。印には購読の endpoint や鍵など、個人に結びつく値を出さない。
"""
import json
import os

import boto3
from boto3.dynamodb.conditions import Key
from pywebpush import WebPushException, webpush

_dynamodb = boto3.resource("dynamodb")
_secrets = boto3.client("secretsmanager")


def _vapid_private_key():
    name = os.environ["VAPID_SECRET_NAME"]
    return _secrets.get_secret_value(SecretId=name)["SecretString"].strip()


def _print_send_failed(status, exc):
    # endpoint・鍵・例外メッセージ（endpoint を含みうる）は出さない
    shown = "none" if status is None else status
    print(f"[PUSH SEND FAILED] status={shown} reason={type(exc).__name__}")


def handler(event=None, context=None):
    table = _dynamodb.Table(os.environ["TABLE_NAME"])
    subject = os.environ.get("VAPID_SUBJECT", "mailto:info@veai.jp")
    private_key = _vapid_private_key()

    sent = 0
    removed = 0
    failed = 0
    skipped = 0
    start_key = None
    while True:
        kwargs = {"KeyConditionExpression": Key("PK").eq("PUSHSUB")}
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        resp = table.query(**kwargs)
        for it in resp.get("Items", []):
            try:
                sub = json.loads(it["subscription"])
            except (KeyError, ValueError, TypeError) as e:
                skipped += 1
                print(f"[PUSH SUB SKIPPED] reason={type(e).__name__}")
                continue
            try:
                webpush(
                    subscription_info=sub,
                    data=None,
                    vapid_private_key=private_key,
                    vapid_claims={"sub": subject},
                )
                sent += 1
            except WebPushException as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status in (404, 410):
                    table.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})
                    removed += 1
                else:
                    failed += 1
                    _print_send_failed(status, e)
            except Exception as e:  # noqa: BLE001 個別失敗は他をブロックしない
                failed += 1
                _print_send_failed(None, e)
        start_key = resp.get("LastEvaluatedKey")
        if not start_key:
            break

    print(
        f"[PUSH SUMMARY] sent={sent} removed={removed} failed={failed} skipped={skipped}"
    )
    return {"sent": sent, "removed": removed, "failed": failed, "skipped": skipped}
