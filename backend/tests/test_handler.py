import base64
import json

import pytest

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


# --- OCR: 純ロジック単体 -------------------------------------------------

def test_clean_ocr_line_strips_bullets_numbers_and_colons(dynamodb_table):
    c = dynamodb_table._clean_ocr_line
    assert c("・パジャマ") == "パジャマ"          # 箇条書き記号
    assert c("1. 歯ブラシ") == "歯ブラシ"          # 連番
    assert c("(12) タオル") == "タオル"            # 括弧付き連番
    assert c("☑ 靴下") == "靴下"                   # チェックボックス
    assert c("  下着　　2枚 ") == "下着 2枚"       # 全角空白の正規化と連続空白の圧縮(数量は保持)
    assert c("メモ：") == "メモ"                   # 末尾コロン除去
    assert c(None) == ""                           # None 安全
    assert c("１２３") == "123"                     # NFKC で全角数字→半角


def test_looks_like_item_filters_headers_and_noise(dynamodb_table):
    ok = dynamodb_table._looks_like_item
    assert ok("パジャマ") is True
    assert ok("くつした") is True
    assert ok("a") is False                        # 短すぎ
    assert ok("12345") is False                    # 数字のみ(かな/漢字/英字なし)
    assert ok("持ち物リスト") is False              # 見出し語
    assert ok("氏名 山田太郎") is False             # 個人情報の見出し
    assert ok("TEL 03-1234-5678") is False         # tel 除外
    assert ok("x" * 101) is False                  # 長すぎ


def test_extract_item_candidates_dedups_and_splits(dynamodb_table):
    lines = [
        {"text": "・パジャマ", "confidence": 95.44},
        {"text": "パジャマ", "confidence": 80},         # 重複キー→無視
        {"text": "歯ブラシ、コップ", "confidence": 90},  # 読点で分割
        {"text": "タオル／バスタオル", "confidence": 88},  # スラッシュで分割
    ]
    got = dynamodb_table._extract_item_candidates(lines)
    assert [c["name"] for c in got] == [
        "パジャマ", "歯ブラシ", "コップ", "タオル", "バスタオル",
    ]
    assert got[0]["confidence"] == 95.4            # 小数1桁に丸め


def test_extract_item_candidates_caps_at_max(dynamodb_table):
    lines = [{"text": f"品目{i}", "confidence": 90} for i in range(80)]
    got = dynamodb_table._extract_item_candidates(lines)
    assert len(got) == dynamodb_table._MAX_OCR_ITEMS


def test_image_mime_type_detects_and_validates(dynamodb_table):
    m = dynamodb_table._image_mime_type
    assert m(b"\xff\xd8\xff\xe0\x00\x10JFIF", None) == "image/jpeg"
    assert m(PNG_BYTES, None) == "image/png"
    assert m(b"RIFF\x00\x00\x00\x00WEBPVP8 ", None) == "image/webp"
    # requested が許可セット内なら信頼する
    assert m(b"\xff\xd8\xff", "image/png") == "image/png"
    # 未知フォーマットは弾く
    with pytest.raises(dynamodb_table._BadRequest):
        m(b"GIF89a\x00\x00\x00\x00", None)


def test_extract_json_object_handles_prose_and_missing(dynamodb_table):
    handler = dynamodb_table
    obj = handler._extract_json_object('前置き {"items": [{"name": "タオル"}]} 後書き')
    assert obj == {"items": [{"name": "タオル"}]}
    with pytest.raises(handler._OcrUnavailable):
        handler._extract_json_object("no json here")


def test_openai_output_text_supports_both_shapes(dynamodb_table):
    otext = dynamodb_table._openai_output_text
    assert otext({"output_text": "hello"}) == "hello"
    nested = {
        "output": [
            {"type": "message", "content": [
                {"type": "output_text", "text": "A"},
                {"type": "text", "text": "B"},
            ]},
            {"type": "reasoning", "content": []},  # message 以外は無視
        ]
    }
    assert otext(nested) == "A\nB"


# --- OCR: 統合エラーパス -------------------------------------------------

def _ocr_event():
    return make_event(
        "POST",
        "/v1/ocr/items",
        body={"imageBase64": base64.b64encode(PNG_BYTES).decode("ascii")},
    )


def test_ocr_items_rejects_missing_image(dynamodb_table):
    resp = dynamodb_table.lambda_handler(
        make_event("POST", "/v1/ocr/items", body={})
    )
    assert resp["statusCode"] == 400
    assert _body(resp)["error"] == "imageBase64 is required"


def test_ocr_items_rejects_oversized_image(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_MAX_BYTES", 10)
    resp = handler.lambda_handler(_ocr_event())
    assert resp["statusCode"] == 400
    assert "bytes" in _body(resp)["error"]


def test_ocr_items_rejects_unknown_image_format(dynamodb_table):
    gif = base64.b64encode(b"GIF89a" + b"\x00" * 20).decode("ascii")
    resp = dynamodb_table.lambda_handler(
        make_event("POST", "/v1/ocr/items", body={"imageBase64": gif})
    )
    assert resp["statusCode"] == 400


def test_ocr_items_unsupported_provider_returns_503(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "banana")
    resp = handler.lambda_handler(_ocr_event())
    assert resp["statusCode"] == 503


def test_ocr_items_enforces_daily_limit(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "textract")
    monkeypatch.setattr(handler, "OCR_DAILY_LIMIT", 1)

    class FakeTextract:
        def detect_document_text(self, Document):  # noqa: N802
            return {
                "DocumentMetadata": {"Pages": 1},
                "Blocks": [{"BlockType": "LINE", "Text": "タオル", "Confidence": 90}],
            }

    monkeypatch.setattr(handler, "_textract", FakeTextract())
    assert handler.lambda_handler(_ocr_event())["statusCode"] == 200
    resp = handler.lambda_handler(_ocr_event())    # 同一IPで上限超過
    assert resp["statusCode"] == 429
    assert _body(resp)["error"] == "OCR daily limit reached"


def test_ocr_items_hides_openai_auth_errors(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "openai")
    monkeypatch.setattr(handler, "_openai_api_key_cache", "test-key")

    def fake_urlopen(req, timeout):
        raise handler.urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", {}, None
        )

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)
    resp = handler.lambda_handler(_ocr_event())
    assert resp["statusCode"] == 503
    assert _body(resp) == {"error": "OCR service is not configured"}


def test_ocr_items_handles_non_json_openai_response(dynamodb_table, monkeypatch):
    handler = dynamodb_table
    monkeypatch.setattr(handler, "OCR_PROVIDER", "openai")
    monkeypatch.setattr(handler, "_openai_api_key_cache", "test-key")

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"output_text": "リストは見つかりません"}).encode("utf-8")

    monkeypatch.setattr(
        handler.urllib.request, "urlopen", lambda req, timeout: FakeResponse()
    )
    resp = handler.lambda_handler(_ocr_event())
    assert resp["statusCode"] == 503


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
