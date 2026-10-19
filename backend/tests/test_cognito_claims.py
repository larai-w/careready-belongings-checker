"""Cognito トークンへのクレーム追加(acr / amr 等)に対する耐性テスト。

2026-11 以降、Cognito の ID/アクセストークンに acr(文字列)と amr(文字列配列)が
加わる。handler は必要なクレーム(custom:facilityId / sub)だけを読み、知らない
クレームは無視する設計であることを固定する。詳細: docs/cognito-additive-claims-2026-10.md
"""

import json

import pytest

from conftest import make_event

FAC = "fac-claims"

# HTTP API の JWT オーソライザーは配列クレームを "[a b]" 形式の文字列で渡す。
# Lambda を直接呼ぶ経路やテストでは配列のまま来る可能性もあるため両方を確認する。
ADDITIVE_CLAIM_SHAPES = [
    pytest.param({"acr": "1", "amr": ["pwd"]}, id="amr-as-list"),
    pytest.param({"acr": "1", "amr": "[pwd]"}, id="amr-as-apigw-string"),
    pytest.param({"acr": "2", "amr": ["pwd", "otp", "mfa"]}, id="amr-mfa-list"),
    pytest.param({"acr": "", "amr": []}, id="empty-values"),
    pytest.param(
        {
            "acr": "1",
            "amr": "[pwd otp]",
            "auth_time": "1793750400",
            "origin_jti": "00000000-0000-0000-0000-000000000000",
            "cognito:groups": "[staff]",
            "future_unknown_claim": {"nested": True},
        },
        id="unknown-future-claims",
    ),
]


def _body(resp):
    return json.loads(resp["body"])


@pytest.mark.parametrize("extra", ADDITIVE_CLAIM_SHAPES)
def test_crud_accepts_additive_claims_with_facility_id(dynamodb_table, extra):
    handler = dynamodb_table
    resp = handler.lambda_handler(
        make_event(
            "POST",
            "/v1/facility/templates",
            body={"name": "テスト", "items": [{"name": "パジャマ"}]},
            facility_id=FAC,
            extra_claims=extra,
        )
    )
    assert resp["statusCode"] == 201

    # 同じ facilityId のスコープで読める(追加クレームがスコープに影響しない)
    resp = handler.lambda_handler(
        make_event(
            "GET", "/v1/facility/templates", facility_id=FAC, extra_claims=extra
        )
    )
    assert resp["statusCode"] == 200
    assert len(_body(resp)["templates"]) == 1


@pytest.mark.parametrize("extra", ADDITIVE_CLAIM_SHAPES)
def test_sub_fallback_accepts_additive_claims(dynamodb_table, extra):
    handler = dynamodb_table
    resp = handler.lambda_handler(
        make_event(
            "GET", "/v1/facility/templates", sub=FAC, extra_claims=extra
        )
    )
    assert resp["statusCode"] == 200


def test_additive_claims_alone_do_not_grant_identity(dynamodb_table):
    """acr/amr だけでは識別子にならない(従来どおり 401)。"""
    handler = dynamodb_table
    resp = handler.lambda_handler(
        make_event(
            "GET",
            "/v1/facility/templates",
            extra_claims={"acr": "1", "amr": ["pwd"]},
        )
    )
    assert resp["statusCode"] == 401
