import os
import sys

import boto3
import pytest
from moto import mock_aws

# backend/src を import パスに追加
_SRC = os.path.join(os.path.dirname(__file__), "..", "src")
sys.path.insert(0, os.path.abspath(_SRC))

TABLE_NAME = "careready-main"


@pytest.fixture()
def dynamodb_table():
    os.environ["TABLE_NAME"] = TABLE_NAME
    os.environ["GSI1_NAME"] = "GSI1"
    os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-1")
    with mock_aws():
        client = boto3.resource("dynamodb", region_name="ap-northeast-1")
        client.create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
                {"AttributeName": "GSI1PK", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "GSI1",
                    "KeySchema": [
                        {"AttributeName": "GSI1PK", "KeyType": "HASH"}
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        # handler は import 時に module 変数へ boto3.resource() を束縛するため
        # mock_aws コンテキスト内で reload する
        import importlib

        import handler as handler_module

        importlib.reload(handler_module)
        yield handler_module


def make_event(method, path, body=None, tpl_id=None, facility_id=None, sub=None):
    """HTTP API v2 形式のイベントを組み立てる。"""
    route_path = path
    path_params = {}
    if tpl_id is not None:
        path_params["tplId"] = tpl_id
        route_path = "/v1/facility/templates/{tplId}"

    claims = {}
    if facility_id is not None:
        claims["custom:facilityId"] = facility_id
    if sub is not None:
        claims["sub"] = sub

    event = {
        "routeKey": f"{method} {route_path}",
        "rawPath": path,
        "pathParameters": path_params,
        "requestContext": {
            "http": {"method": method, "path": path},
            "authorizer": {"jwt": {"claims": claims}},
        },
    }
    if body is not None:
        import json

        event["body"] = json.dumps(body)
    return event
