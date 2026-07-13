"""CareReady バックエンド Lambda(単一関数+内部ルーター)。

外部依存は boto3 のみ。DynamoDB は resource API で統一。
"""
import decimal
import json
import os
import secrets
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "careready-main")
GSI1_NAME = os.environ.get("GSI1_NAME", "GSI1")

# shareCode で使う英大数字(紛らわしい I/O/0/1 を除外)
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_LENGTH = 6

# バリデーション上限
_MAX_NAME_LEN = 100
_MAX_ITEMS = 200

_dynamodb = boto3.resource("dynamodb")


def _table():
    return _dynamodb.Table(TABLE_NAME)


class _DecimalEncoder(json.JSONEncoder):
    """DynamoDB が返す Decimal を JSON 化する。"""

    def default(self, o):
        if isinstance(o, decimal.Decimal):
            return int(o) if o == o.to_integral_value() else float(o)
        return super().default(o)


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body, ensure_ascii=False, cls=_DecimalEncoder),
    }


def _error(status, message):
    return _response(status, {"error": message})


def _gen_share_code():
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))


# --- リクエスト解析ヘルパ -------------------------------------------------

def _parse_body(event):
    raw = event.get("body")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        raise _BadRequest("invalid JSON body")


def _facility_id(event):
    """JWT クレームから facilityId を取得(なければ sub をフォールバック)。"""
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    fac = claims.get("custom:facilityId")
    if fac:
        return fac
    sub = claims.get("sub")
    if sub:
        return sub
    raise _Unauthorized("missing identity claims")


class _BadRequest(Exception):
    pass


class _Unauthorized(Exception):
    pass


# --- バリデーション -------------------------------------------------------

def _validate_template(body):
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        raise _BadRequest("name is required")
    if len(name) > _MAX_NAME_LEN:
        raise _BadRequest(f"name must be <= {_MAX_NAME_LEN} chars")

    items = body.get("items", [])
    if not isinstance(items, list):
        raise _BadRequest("items must be a list")
    if len(items) > _MAX_ITEMS:
        raise _BadRequest(f"items must be <= {_MAX_ITEMS} entries")
    for it in items:
        if not isinstance(it, dict):
            raise _BadRequest("each item must be an object")
        item_name = it.get("name")
        if not isinstance(item_name, str) or not item_name.strip():
            raise _BadRequest("each item requires a name")
        if len(item_name) > _MAX_NAME_LEN:
            raise _BadRequest(f"item name must be <= {_MAX_NAME_LEN} chars")

    overrides = body.get("overrides", {})
    if not isinstance(overrides, dict):
        raise _BadRequest("overrides must be an object")

    return name, items, overrides


# --- ハンドラ本体 ---------------------------------------------------------

def redeem(event):
    body = _parse_body(event)
    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        return _error(400, "code is required")
    code = code.strip().upper()

    resp = _table().query(
        IndexName=GSI1_NAME,
        KeyConditionExpression=Key("GSI1PK").eq(
            f"CODE#{code}"
        ),
        Limit=1,
    )
    items = resp.get("Items", [])
    if not items:
        return _error(404, "template not found")

    tpl = items[0]
    return _response(
        200,
        {
            "name": tpl.get("name"),
            "items": tpl.get("items", []),
            "overrides": tpl.get("overrides", {}),
            "facilityName": tpl.get("facilityName"),
            "shareCode": tpl.get("shareCode"),
        },
    )


def _tpl_view(item):
    return {
        "tplId": item.get("tplId"),
        "name": item.get("name"),
        "items": item.get("items", []),
        "overrides": item.get("overrides", {}),
        "shareCode": item.get("shareCode"),
        "updatedAt": item.get("updatedAt"),
    }


def list_templates(event):
    fac = _facility_id(event)
    resp = _table().query(
        KeyConditionExpression=(
            Key("PK").eq(f"FAC#{fac}")
            & Key("SK").begins_with("TPL#")
        )
    )
    return _response(
        200, {"templates": [_tpl_view(i) for i in resp.get("Items", [])]}
    )


def create_template(event):
    fac = _facility_id(event)
    body = _parse_body(event)
    name, items, overrides = _validate_template(body)

    tpl_id = uuid.uuid4().hex
    share_code = _gen_share_code()
    now = int(time.time())
    facility_name = body.get("facilityName")

    item = {
        "PK": f"FAC#{fac}",
        "SK": f"TPL#{tpl_id}",
        "GSI1PK": f"CODE#{share_code}",
        "tplId": tpl_id,
        "name": name,
        "items": items,
        "overrides": overrides,
        "shareCode": share_code,
        "facilityName": facility_name,
        "updatedAt": now,
    }
    _table().put_item(Item=item)
    return _response(201, _tpl_view(item))


def get_template(event, tpl_id):
    fac = _facility_id(event)
    resp = _table().get_item(Key={"PK": f"FAC#{fac}", "SK": f"TPL#{tpl_id}"})
    item = resp.get("Item")
    if not item:
        return _error(404, "template not found")
    return _response(200, _tpl_view(item))


def update_template(event, tpl_id):
    fac = _facility_id(event)
    body = _parse_body(event)
    name, items, overrides = _validate_template(body)

    key = {"PK": f"FAC#{fac}", "SK": f"TPL#{tpl_id}"}
    existing = _table().get_item(Key=key).get("Item")
    if not existing:
        return _error(404, "template not found")

    now = int(time.time())
    facility_name = body.get("facilityName", existing.get("facilityName"))
    try:
        _table().update_item(
            Key=key,
            UpdateExpression=(
                "SET #n = :n, #items = :items, overrides = :ov, "
                "facilityName = :fn, updatedAt = :ua"
            ),
            ExpressionAttributeNames={"#n": "name", "#items": "items"},
            ExpressionAttributeValues={
                ":n": name,
                ":items": items,
                ":ov": overrides,
                ":fn": facility_name,
                ":ua": now,
            },
            ConditionExpression="attribute_exists(PK)",
        )
    except ClientError:
        return _error(404, "template not found")

    updated = _table().get_item(Key=key).get("Item")
    return _response(200, _tpl_view(updated))


def delete_template(event, tpl_id):
    fac = _facility_id(event)
    key = {"PK": f"FAC#{fac}", "SK": f"TPL#{tpl_id}"}
    existing = _table().get_item(Key=key).get("Item")
    if not existing:
        return _error(404, "template not found")
    _table().delete_item(Key=key)
    return _response(204, {})


# --- ルーター -------------------------------------------------------------

def _resolve_route(event):
    """(routeKey, tplId) を返す。routeKey は "METHOD /path" 形式に正規化。"""
    # HTTP API v2 は routeKey を提供("POST /v1/facility/templates/{tplId}")
    route_key = event.get("routeKey")
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
    )
    path_params = event.get("pathParameters") or {}

    if route_key and route_key != "$default":
        return route_key, path_params.get("tplId")

    # フォールバック: 生パスから routeKey とパスパラメータを再構築
    path = (
        event.get("rawPath")
        or event.get("requestContext", {}).get("http", {}).get("path")
        or event.get("path", "")
    )
    parts = [p for p in path.split("/") if p]
    # /v1/facility/templates/{tplId}
    if len(parts) == 4 and parts[:3] == ["v1", "facility", "templates"]:
        return f"{method} /v1/facility/templates/{{tplId}}", parts[3]
    return f"{method} {path}", path_params.get("tplId")


def lambda_handler(event, context=None):
    try:
        rk, tpl_id = _resolve_route(event)

        if rk == "POST /v1/templates/redeem":
            return redeem(event)
        if rk == "GET /v1/facility/templates":
            return list_templates(event)
        if rk == "POST /v1/facility/templates":
            return create_template(event)
        if rk == "GET /v1/facility/templates/{tplId}":
            return get_template(event, tpl_id)
        if rk == "PUT /v1/facility/templates/{tplId}":
            return update_template(event, tpl_id)
        if rk == "DELETE /v1/facility/templates/{tplId}":
            return delete_template(event, tpl_id)

        return _error(404, "route not found")
    except _BadRequest as e:
        return _error(400, str(e))
    except _Unauthorized as e:
        return _error(401, str(e))
    except Exception as e:  # noqa: BLE001 予期しないエラーは500
        return _error(500, f"internal error: {e}")
