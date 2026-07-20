import base64
import json

from conftest import make_event

FAC = "fac-123"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def _body(resp):
    return json.loads(resp["body"])


def _create(handler, name="入院準備リスト", items=None, sub_only=False):
    kwargs = {"sub": FAC} if sub_only else {"facility_id": FAC}
    ev = make_event(
        "POST",
        "/v1/facility/templates",
        body={"name": name, "items": items or [{"name": "パジャマ"}]},
        **kwargs,
    )
    return handler.lambda_handler(ev)


# --- CRUD ハッピーパス ---------------------------------------------------

def test_create_template_generates_share_code(dynamodb_table):
    handler = dynamodb_table
    resp = _create(handler, items=[{"name": "パジャマ"}, {"name": "タオル"}])
    assert resp["statusCode"] == 201
    data = _body(resp)
    code = data["shareCode"]
    assert len(code) == 6
    # 紛らわしい文字は含まれない
    assert not (set(code) & set("IO01"))
    assert data["name"] == "入院準備リスト"


def test_list_templates(dynamodb_table):
    handler = dynamodb_table
    _create(handler, name="リストA")
    _create(handler, name="リストB")
    resp = handler.lambda_handler(
        make_event("GET", "/v1/facility/templates", facility_id=FAC)
    )
    assert resp["statusCode"] == 200
    names = {t["name"] for t in _body(resp)["templates"]}
    assert names == {"リストA", "リストB"}


def test_get_update_delete_roundtrip(dynamodb_table):
    handler = dynamodb_table
    tpl_id = _body(_create(handler))["tplId"]

    # GET
    resp = handler.lambda_handler(
        make_event("GET", "/x", tpl_id=tpl_id, facility_id=FAC)
    )
    assert resp["statusCode"] == 200

    # PUT
    resp = handler.lambda_handler(
        make_event(
            "PUT",
            "/x",
            body={"name": "更新後", "items": [{"name": "歯ブラシ"}]},
            tpl_id=tpl_id,
            facility_id=FAC,
        )
    )
    assert resp["statusCode"] == 200
    assert _body(resp)["name"] == "更新後"

    # DELETE
    resp = handler.lambda_handler(
        make_event("DELETE", "/x", tpl_id=tpl_id, facility_id=FAC)
    )
    assert resp["statusCode"] == 204

    # 削除後は 404
    resp = handler.lambda_handler(
        make_event("GET", "/x", tpl_id=tpl_id, facility_id=FAC)
    )
    assert resp["statusCode"] == 404


# --- redeem --------------------------------------------------------------

def test_redeem_happy_path(dynamodb_table):
    handler = dynamodb_table
    code = _body(_create(handler))["shareCode"]
    resp = handler.lambda_handler(
        make_event("POST", "/v1/templates/redeem", body={"code": code})
    )
    assert resp["statusCode"] == 200
    data = _body(resp)
    assert data["name"] == "入院準備リスト"
    assert data["shareCode"] == code


def test_redeem_not_found_returns_404(dynamodb_table):
    handler = dynamodb_table
    resp = handler.lambda_handler(
        make_event("POST", "/v1/templates/redeem", body={"code": "ZZZZZZ"})
    )
    assert resp["statusCode"] == 404
    assert "error" in _body(resp)


# --- OCR ---------------------------------------------------------------

def test_ocr_items_extracts_candidates(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "textract")

    class FakeTextract:
        def detect_document_text(self, Document):  # noqa: N802
            assert Document["Bytes"] == PNG_BYTES
            return {
                "DocumentMetadata": {"Pages": 1},
                "Blocks": [
                    {"BlockType": "LINE", "Text": "持ち物リスト", "Confidence": 99},
                    {"BlockType": "LINE", "Text": "・パジャマ 2組", "Confidence": 95.4},
                    {"BlockType": "LINE", "Text": "氏名 山田太郎", "Confidence": 98},
                    {"BlockType": "LINE", "Text": "歯ブラシ・コップ", "Confidence": 91.2},
                ],
            }

    monkeypatch.setattr(handler, "_textract", FakeTextract())
    resp = handler.lambda_handler(
        make_event(
            "POST",
            "/v1/ocr/items",
            body={"imageBase64": base64.b64encode(PNG_BYTES).decode("ascii")},
        )
    )
    assert resp["statusCode"] == 200
    data = _body(resp)
    assert data["lineCount"] == 4
    assert data["items"] == [
        {"name": "パジャマ 2組", "confidence": 95.4},
        {"name": "歯ブラシ・コップ", "confidence": 91.2},
    ]


def test_ocr_items_extracts_openai_candidates(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "openai")
    monkeypatch.setattr(handler, "_openai_api_key_cache", "test-key")

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(
                {
                    "output_text": json.dumps(
                        {
                            "items": [
                                {"name": "パジャマ 2組"},
                                {"name": "氏名 山田太郎"},
                                {"name": "歯ブラシ・コップ"},
                            ]
                        },
                        ensure_ascii=False,
                    )
                },
                ensure_ascii=False,
            ).encode("utf-8")

    def fake_urlopen(req, timeout):
        assert timeout == 18
        payload = json.loads(req.data.decode("utf-8"))
        assert payload["model"] == handler.OPENAI_OCR_MODEL
        image_url = payload["input"][0]["content"][1]["image_url"]
        assert image_url.startswith("data:image/png;base64,")
        return FakeResponse()

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    resp = handler.lambda_handler(
        make_event(
            "POST",
            "/v1/ocr/items",
            body={"imageBase64": base64.b64encode(PNG_BYTES).decode("ascii")},
        )
    )
    assert resp["statusCode"] == 200
    data = _body(resp)
    assert data["provider"] == "openai"
    assert data["items"] == [
        {"name": "パジャマ 2組", "confidence": 0},
        {"name": "歯ブラシ・コップ", "confidence": 0},
    ]


def test_ocr_items_hides_openai_rate_limit_details(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "openai")
    monkeypatch.setattr(handler, "_openai_api_key_cache", "test-key")

    def fake_urlopen(req, timeout):
        raise handler.urllib.error.HTTPError(
            req.full_url,
            429,
            "Too Many Requests",
            {},
            None,
        )

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    resp = handler.lambda_handler(
        make_event(
            "POST",
            "/v1/ocr/items",
            body={"imageBase64": base64.b64encode(PNG_BYTES).decode("ascii")},
        )
    )
    assert resp["statusCode"] == 503
    assert _body(resp) == {"error": "OCR service is temporarily unavailable"}


def test_ocr_items_rejects_invalid_base64(dynamodb_table):
    handler = dynamodb_table
    resp = handler.lambda_handler(
        make_event("POST", "/v1/ocr/items", body={"imageBase64": "not base64"})
    )
    assert resp["statusCode"] == 400


# --- バリデーション ------------------------------------------------------

def test_create_rejects_empty_name(dynamodb_table):
    handler = dynamodb_table
    resp = handler.lambda_handler(
        make_event(
            "POST",
            "/v1/facility/templates",
            body={"name": "", "items": []},
            facility_id=FAC,
        )
    )
    assert resp["statusCode"] == 400
    assert "error" in _body(resp)


def test_create_rejects_too_many_items(dynamodb_table):
    handler = dynamodb_table
    items = [{"name": f"item{i}"} for i in range(201)]
    resp = _create(handler, items=items)
    assert resp["statusCode"] == 400


def test_create_rejects_long_item_name(dynamodb_table):
    handler = dynamodb_table
    resp = _create(handler, items=[{"name": "x" * 101}])
    assert resp["statusCode"] == 400


# --- facilityId フォールバック(sub 使用)------------------------------

def test_facility_id_falls_back_to_sub(dynamodb_table):
    handler = dynamodb_table
    resp = _create(handler, sub_only=True)
    assert resp["statusCode"] == 201
    # sub でスコープされたリストが取得できる
    resp = handler.lambda_handler(
        make_event("GET", "/v1/facility/templates", sub=FAC)
    )
    assert resp["statusCode"] == 200
    assert len(_body(resp)["templates"]) == 1
