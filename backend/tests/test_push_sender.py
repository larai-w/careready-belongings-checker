"""push_sender（毎日1回の Web Push 送信 Lambda）の振る舞いを固定する。

pywebpush の大きな版上げ（Dependabot #119: >=2.5.0）の前に、送る相手・渡す引数・
失効した購読の削除を回帰テストで押さえる。CI は pywebpush を入れないので、
ここでは webpush をテスト用の偽物に差し替え、**渡している引数そのもの**を確かめる
（モックは何でも受け取るため、呼んだことだけを見ても壊れ方は分からない）。
"""
import importlib
import json
import os
import sys
import types

import boto3
import pytest
from moto import mock_aws

_PUSH_SENDER = os.path.join(os.path.dirname(__file__), "..", "push_sender")

TABLE_NAME = "careready-main"
SECRET_NAME = "careready/vapid-private-key"
PRIVATE_KEY = "test-vapid-private-key"


class FakeWebPushException(Exception):
    def __init__(self, message, response=None):
        super().__init__(message)
        self.response = response


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


@pytest.fixture()
def push_env(monkeypatch):
    """moto の DynamoDB / Secrets Manager と、偽の pywebpush を用意して sender を読む。"""
    calls = []
    outcomes = {}

    def fake_webpush(**kwargs):
        calls.append(kwargs)
        status = outcomes.get(kwargs["subscription_info"]["endpoint"])
        if status is not None:
            raise FakeWebPushException("push failed", response=FakeResponse(status))

    fake_module = types.ModuleType("pywebpush")
    fake_module.webpush = fake_webpush
    fake_module.WebPushException = FakeWebPushException
    monkeypatch.setitem(sys.modules, "pywebpush", fake_module)
    monkeypatch.syspath_prepend(os.path.abspath(_PUSH_SENDER))
    monkeypatch.setenv("TABLE_NAME", TABLE_NAME)
    monkeypatch.setenv("VAPID_SECRET_NAME", SECRET_NAME)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-northeast-1")
    monkeypatch.delenv("VAPID_SUBJECT", raising=False)

    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="ap-northeast-1")
        table = dynamodb.create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        boto3.client("secretsmanager", region_name="ap-northeast-1").create_secret(
            Name=SECRET_NAME, SecretString=PRIVATE_KEY + "\n"
        )
        # sender は import 時に boto3 のクライアントを作るので、mock の中で読み直す
        import sender as sender_module

        importlib.reload(sender_module)
        yield types.SimpleNamespace(
            sender=sender_module, table=table, calls=calls, outcomes=outcomes
        )


def _subscribe(table, sk, endpoint):
    subscription = {
        "endpoint": endpoint,
        "keys": {"p256dh": "p256dh-" + sk, "auth": "auth-" + sk},
    }
    table.put_item(
        Item={"PK": "PUSHSUB", "SK": sk, "subscription": json.dumps(subscription)}
    )
    return subscription


def _remaining_sks(table):
    return sorted(item["SK"] for item in table.scan()["Items"])


def test_sends_payloadless_push_with_vapid_to_every_subscription(push_env):
    sub_a = _subscribe(push_env.table, "a", "https://push.example/a")
    sub_b = _subscribe(push_env.table, "b", "https://push.example/b")

    result = push_env.sender.handler()

    assert result == {"sent": 2, "removed": 0}
    sent_to = sorted(call["subscription_info"]["endpoint"] for call in push_env.calls)
    assert sent_to == [sub_a["endpoint"], sub_b["endpoint"]]
    for call in push_env.calls:
        # 予定は端末の中にだけあるので、サーバーからは中身なし（data=None）で送る
        assert call["data"] is None
        # Secrets Manager の値は前後の空白を落として渡す
        assert call["vapid_private_key"] == PRIVATE_KEY
        assert call["vapid_claims"] == {"sub": "mailto:info@veai.jp"}
        assert call["subscription_info"] in (sub_a, sub_b)


def test_vapid_subject_can_be_overridden(push_env, monkeypatch):
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:ops@example.com")
    _subscribe(push_env.table, "a", "https://push.example/a")

    push_env.sender.handler()

    assert push_env.calls[0]["vapid_claims"] == {"sub": "mailto:ops@example.com"}


@pytest.mark.parametrize("status", [404, 410])
def test_gone_subscription_is_deleted(push_env, status):
    _subscribe(push_env.table, "gone", "https://push.example/gone")
    _subscribe(push_env.table, "ok", "https://push.example/ok")
    push_env.outcomes["https://push.example/gone"] = status

    result = push_env.sender.handler()

    assert result == {"sent": 1, "removed": 1}
    assert _remaining_sks(push_env.table) == ["ok"]


@pytest.mark.parametrize("status", [400, 413, 429, 500])
def test_other_push_failures_keep_the_subscription(push_env, status):
    _subscribe(push_env.table, "flaky", "https://push.example/flaky")
    push_env.outcomes["https://push.example/flaky"] = status

    result = push_env.sender.handler()

    assert result == {"sent": 0, "removed": 0}
    assert _remaining_sks(push_env.table) == ["flaky"]


def test_failure_without_response_keeps_the_subscription(push_env, monkeypatch):
    # 接続エラーなど response の無い失敗では、購読を消さない
    _subscribe(push_env.table, "flaky", "https://push.example/flaky")

    def raise_without_response(**kwargs):
        push_env.calls.append(kwargs)
        raise FakeWebPushException("no response")

    monkeypatch.setattr(push_env.sender, "webpush", raise_without_response)

    result = push_env.sender.handler()

    assert result == {"sent": 0, "removed": 0}
    assert _remaining_sks(push_env.table) == ["flaky"]


def test_broken_subscription_record_is_skipped_without_blocking_others(push_env):
    push_env.table.put_item(Item={"PK": "PUSHSUB", "SK": "broken", "subscription": "{not json"})
    push_env.table.put_item(Item={"PK": "PUSHSUB", "SK": "missing"})
    _subscribe(push_env.table, "ok", "https://push.example/ok")

    result = push_env.sender.handler()

    assert result == {"sent": 1, "removed": 0}
    assert [call["subscription_info"]["endpoint"] for call in push_env.calls] == [
        "https://push.example/ok"
    ]
    # 壊れた行は送らないが、勝手に消しもしない
    assert _remaining_sks(push_env.table) == ["broken", "missing", "ok"]


def test_only_push_subscriptions_are_read(push_env):
    _subscribe(push_env.table, "ok", "https://push.example/ok")
    push_env.table.put_item(
        Item={
            "PK": "FACILITY#x",
            "SK": "TEMPLATE#1",
            "subscription": json.dumps({"endpoint": "https://push.example/not-a-sub"}),
        }
    )

    result = push_env.sender.handler()

    assert result == {"sent": 1, "removed": 0}
    assert [call["subscription_info"]["endpoint"] for call in push_env.calls] == [
        "https://push.example/ok"
    ]
