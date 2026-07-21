"""毎日1回動く Web Push 送信 Lambda。

予定日は保存していないので、payload なしの「確認プッシュ」を全購読へ送るだけ。
通知するか/内容は 各端末の Service Worker が端末内データを見て決める。
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


def handler(event=None, context=None):
    table = _dynamodb.Table(os.environ["TABLE_NAME"])
    subject = os.environ.get("VAPID_SUBJECT", "mailto:info@veai.jp")
    private_key = _vapid_private_key()

    sent = 0
    removed = 0
    start_key = None
    while True:
        kwargs = {"KeyConditionExpression": Key("PK").eq("PUSHSUB")}
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        resp = table.query(**kwargs)
        for it in resp.get("Items", []):
            try:
                sub = json.loads(it["subscription"])
            except (KeyError, ValueError, TypeError):
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
            except Exception:  # noqa: BLE001 個別失敗は他をブロックしない
                pass
        start_key = resp.get("LastEvaluatedKey")
        if not start_key:
            break

    return {"sent": sent, "removed": removed}
