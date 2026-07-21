"""CareReady バックエンド Lambda(単一関数+内部ルーター)。

外部依存は boto3 のみ。DynamoDB は resource API で統一。
"""
import decimal
import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import time
import unicodedata
import urllib.error
import urllib.request
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "careready-main")
GSI1_NAME = os.environ.get("GSI1_NAME", "GSI1")
OCR_PROVIDER = os.environ.get("OCR_PROVIDER", "openai").lower()
OCR_MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(4 * 1024 * 1024)))
OCR_DAILY_LIMIT = int(os.environ.get("OCR_DAILY_LIMIT", "20"))
OPENAI_OCR_MODEL = os.environ.get("OPENAI_OCR_MODEL", "gpt-5.6-luna")
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"

# shareCode で使う英大数字(紛らわしい I/O/0/1 を除外)
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_LENGTH = 6

# バリデーション上限
_MAX_NAME_LEN = 100
_MAX_ITEMS = 200
_MAX_OCR_ITEMS = 50

_dynamodb = boto3.resource("dynamodb")
_textract = None
_secretsmanager = None
_openai_api_key_cache = None


def _table():
    return _dynamodb.Table(TABLE_NAME)


def _textract_client():
    global _textract
    if _textract is None:
        _textract = boto3.client(
            "textract",
            region_name=os.environ.get("TEXTRACT_REGION", "us-east-1"),
        )
    return _textract


def _secretsmanager_client():
    global _secretsmanager
    if _secretsmanager is None:
        _secretsmanager = boto3.client("secretsmanager")
    return _secretsmanager


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


class _OcrUnavailable(Exception):
    pass


class _TooManyRequests(Exception):
    pass


# --- OCR ---------------------------------------------------------------

def _clean_ocr_line(text):
    text = unicodedata.normalize("NFKC", str(text or ""))
    text = text.strip()
    text = re.sub(r"^[\s\-\*・●○□■☐☑✓✔]+", "", text)
    text = re.sub(r"^\(?\d{1,3}\)?[\.\)、\s]+", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" :：")


# 品名にまず現れない見出し語(部分一致で除外してよい)
_HEADING_SUBSTRINGS = ("持ち物", "注意", "お願い", "ページ")
# 見出しの語尾(行末/完全一致のときだけ除外。「持ち物リスト」は落とし「リストバンド」は残す)
_HEADING_SUFFIXES = ("チェックリスト", "チェック表", "リスト", "一覧", "チェック")
# 欄ラベル(行頭でラベルとして使われているときだけ除外。「お名前シール」「施設着」は残す)
_LABEL_PREFIXES = (
    "氏名", "名前", "利用者", "入所日", "退所日", "施設", "病院",
    "電話", "住所", "担当", "tel", "fax", "email",
)
_LABEL_SEPARATORS = " :：　、/／ー-"


def _is_header_or_label(text):
    """見出し行・欄ラベル行を判定する(持ち物名の部分一致では落とさない)。"""
    lowered = text.lower()
    if any(term in lowered for term in _HEADING_SUBSTRINGS):
        return True
    if any(lowered == s or lowered.endswith(s) for s in _HEADING_SUFFIXES):
        return True
    for label in _LABEL_PREFIXES:
        if lowered == label:
            return True
        if lowered.startswith(label):
            rest = text[len(label):]
            if rest.startswith("名"):  # 「施設名」「利用者名」などのラベル
                rest = rest[1:]
            # 直後が区切り/数字/行末 = 値を伴うラベル。複合語(名前ペン等)は残す
            if not rest or rest[0] in _LABEL_SEPARATORS or rest[0].isdigit():
                return True
    return False


def _looks_like_item(text):
    if len(text) < 2 or len(text) > _MAX_NAME_LEN:
        return False
    if _is_header_or_label(text):
        return False
    return any(ch.isalpha() or "\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in text)


def _candidate_key(text):
    normalized = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\W_]+", "", normalized)


def _extract_item_candidates(lines):
    candidates = []
    seen = set()
    for line in lines:
        raw = _clean_ocr_line(line.get("text"))
        if not raw:
            continue
        parts = [raw]
        if any(sep in raw for sep in ("、", "／", "/")):
            parts = [p for p in re.split(r"[、／/]+", raw) if p.strip()]
        for part in parts:
            name = _clean_ocr_line(part)
            if not _looks_like_item(name):
                continue
            key = _candidate_key(name)
            if key in seen:
                continue
            seen.add(key)
            candidates.append(
                {
                    "name": name,
                    "confidence": round(float(line.get("confidence") or 0), 1),
                }
            )
            if len(candidates) >= _MAX_OCR_ITEMS:
                return candidates
    return candidates


def _get_openai_api_key():
    global _openai_api_key_cache
    if _openai_api_key_cache:
        return _openai_api_key_cache

    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        _openai_api_key_cache = api_key
        return api_key

    secret_id = (
        os.environ.get("OPENAI_API_KEY_SECRET_ID")
        or os.environ.get("OPENAI_API_KEY_SECRET_ARN")
    )
    if secret_id:
        secret = _secretsmanager_client().get_secret_value(SecretId=secret_id)
        value = secret.get("SecretString", "")
        try:
            parsed = json.loads(value)
            api_key = parsed.get("OPENAI_API_KEY") or parsed.get("api_key")
        except (TypeError, ValueError):
            api_key = value
        if api_key:
            _openai_api_key_cache = api_key
            return api_key

    raise _OcrUnavailable("OpenAI API key is not configured")


def _source_ip(event):
    http = event.get("requestContext", {}).get("http", {})
    if http.get("sourceIp"):
        return http["sourceIp"]
    header = (event.get("headers") or {}).get("x-forwarded-for", "")
    return header.split(",")[0].strip() or "unknown"


def _consume_ocr_quota(event):
    if OCR_DAILY_LIMIT <= 0:
        return
    today = time.strftime("%Y%m%d", time.gmtime())
    ip_hash = hashlib.sha256(_source_ip(event).encode("utf-8")).hexdigest()[:16]
    now = int(time.time())
    try:
        _table().update_item(
            Key={"PK": f"OCR#{today}", "SK": f"IP#{ip_hash}"},
            UpdateExpression=(
                "SET firstSeen = if_not_exists(firstSeen, :now), updatedAt = :now "
                "ADD #count :one"
            ),
            ConditionExpression="attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames={"#count": "count"},
            ExpressionAttributeValues={
                ":one": 1,
                ":now": now,
                ":limit": OCR_DAILY_LIMIT,
            },
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise _TooManyRequests("OCR daily limit reached")
        raise


def _extract_json_object(text):
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise _OcrUnavailable("OCR response did not contain JSON")
    return json.loads(text[start:end + 1])


def _openai_output_text(response):
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    chunks = []
    for item in response.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") in ("output_text", "text") and content.get("text"):
                chunks.append(content["text"])
    return "\n".join(chunks)


def _image_mime_type(image_bytes, requested=None):
    if isinstance(requested, str) and requested in ("image/jpeg", "image/png", "image/webp"):
        return requested
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    raise _BadRequest("image must be JPEG, PNG, or WebP")


def _openai_item_candidates(image_b64, mime_type):
    api_key = _get_openai_api_key()
    prompt = (
        "Extract belongings checklist items from this Japanese care facility "
        "handover image. Return compact JSON only in this exact shape: "
        '{"items":[{"name":"item name"}]}. Include only belongings or supplies. '
        "Exclude resident names, room numbers, phone numbers, dates, facility names, "
        "headings, explanations, and instructions. Keep item names in Japanese. "
        f"Return at most {_MAX_OCR_ITEMS} items."
    )
    payload = {
        "model": OPENAI_OCR_MODEL,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": f"data:{mime_type};base64,{image_b64}",
                        "detail": "high",
                    },
                ],
            }
        ],
    }
    req = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=18) as res:  # nosec B310 固定URLのみ
        response = json.loads(res.read().decode("utf-8"))

    parsed = _extract_json_object(_openai_output_text(response))
    candidates = []
    seen = set()
    for item in parsed.get("items", []):
        name = _clean_ocr_line(item.get("name") if isinstance(item, dict) else item)
        if not _looks_like_item(name):
            continue
        key = _candidate_key(name)
        if key in seen:
            continue
        seen.add(key)
        candidates.append({"name": name, "confidence": 0})
        if len(candidates) >= _MAX_OCR_ITEMS:
            break
    return candidates


def _textract_item_candidates(image_bytes):
    result = _textract_client().detect_document_text(Document={"Bytes": image_bytes})
    lines = [
        {
            "text": block.get("Text", ""),
            "confidence": block.get("Confidence", 0),
        }
        for block in result.get("Blocks", [])
        if block.get("BlockType") == "LINE"
    ]
    return _extract_item_candidates(lines), len(lines), result.get("DocumentMetadata", {}).get("Pages", 1)


def ocr_items(event):
    body = _parse_body(event)
    image_b64 = body.get("imageBase64")
    if not isinstance(image_b64, str) or not image_b64.strip():
        return _error(400, "imageBase64 is required")

    try:
        image_bytes = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError):
        return _error(400, "imageBase64 is invalid")

    if len(image_bytes) > OCR_MAX_BYTES:
        return _error(400, f"image must be <= {OCR_MAX_BYTES} bytes")

    try:
        mime_type = _image_mime_type(image_bytes, body.get("mimeType"))
    except _BadRequest as e:
        return _error(400, str(e))

    try:
        _consume_ocr_quota(event)
        if OCR_PROVIDER == "openai":
            candidates = _openai_item_candidates(image_b64, mime_type)
            line_count = 0
            page_count = 1
        elif OCR_PROVIDER == "textract":
            candidates, line_count, page_count = _textract_item_candidates(image_bytes)
        else:
            return _error(503, f"unsupported OCR provider: {OCR_PROVIDER}")
    except _TooManyRequests as e:
        return _error(429, str(e))
    except _OcrUnavailable as e:
        return _error(503, str(e))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return _error(503, "OCR service is temporarily unavailable")
        if e.code in (401, 403):
            return _error(503, "OCR service is not configured")
        return _error(502, f"openai failed: HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError):
        return _error(502, "openai request failed")
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "TextractError")
        return _error(502, f"textract failed: {code}")
    except (TypeError, ValueError):
        return _error(502, "OCR response was invalid")

    return _response(
        200,
        {
            "items": candidates,
            "lineCount": line_count,
            "pageCount": page_count,
            "provider": OCR_PROVIDER,
        },
    )


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


# --- フィードバック -------------------------------------------------------

def submit_feedback(event):
    """アプリ内フォームからのご意見を保存(製品タグ=careready)。"""
    body = _parse_body(event)
    message = (body.get("message") or "").strip()
    if not message:
        raise _BadRequest("message is required")
    message = message[:2000]
    contact = (body.get("contact") or "").strip()[:200]
    now = int(time.time())
    fb_id = uuid.uuid4().hex
    item = {
        "PK": "FEEDBACK",
        "SK": f"FB#{now}#{fb_id}",
        "product": "careready",
        "message": message,
        "contact": contact,
        "sourceIp": _source_ip(event),
        "createdAt": now,
    }
    _table().put_item(Item=item)
    return _response(201, {"ok": True})


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
    if len(parts) == 3 and parts == ["v1", "ocr", "items"]:
        return f"{method} /v1/ocr/items", path_params.get("tplId")
    return f"{method} {path}", path_params.get("tplId")


def lambda_handler(event, context=None):
    try:
        rk, tpl_id = _resolve_route(event)

        if rk == "POST /v1/feedback":
            return submit_feedback(event)
        if rk == "POST /v1/templates/redeem":
            return redeem(event)
        if rk == "POST /v1/ocr/items":
            return ocr_items(event)
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
