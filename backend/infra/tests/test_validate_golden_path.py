from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path


INFRA_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INFRA_ROOT))

import validate_golden_path as golden_path  # noqa: E402


def passing_template() -> dict:
    return {
        "Resources": {
            "RecordsTable": {
                "Type": "AWS::DynamoDB::Table",
                "DeletionPolicy": "Retain",
                "UpdateReplacePolicy": "Retain",
                "Properties": {
                    "PointInTimeRecoverySpecification": {
                        "PointInTimeRecoveryEnabled": True,
                    },
                },
            },
            "ApiLogGroup": {
                "Type": "AWS::Logs::LogGroup",
                "Properties": {"RetentionInDays": 30},
            },
            "ApiFunction": {
                "Type": "AWS::Lambda::Function",
                "Properties": {"FunctionName": "careready-api"},
            },
            "ApiVersion": {
                "Type": "AWS::Lambda::Version",
                "DeletionPolicy": "Retain",
                "UpdateReplacePolicy": "Retain",
                "Properties": {"FunctionName": {"Ref": "ApiFunction"}},
            },
            "ApiProdAlias": {
                "Type": "AWS::Lambda::Alias",
                "Properties": {
                    "Name": "prod",
                    "FunctionName": {"Ref": "ApiFunction"},
                    "FunctionVersion": {"Fn::GetAtt": ["ApiVersion", "Version"]},
                },
            },
            "HttpApi": {
                "Type": "AWS::ApiGatewayV2::Api",
                "Properties": {"ProtocolType": "HTTP"},
            },
            "HttpApiStage": {
                "Type": "AWS::ApiGatewayV2::Stage",
                "Properties": {
                    "DefaultRouteSettings": {
                        "ThrottlingRateLimit": 10,
                        "ThrottlingBurstLimit": 20,
                    },
                },
            },
        },
    }


class GoldenPathTests(unittest.TestCase):
    def validate(self, template: dict) -> list[golden_path.Finding]:
        return golden_path.validate(
            template,
            lambda_alias_selectors=("^careready-api$",),
            require_api_throttling=True,
        )

    def test_passing_contract(self) -> None:
        self.assertEqual([], self.validate(passing_template()))

    def test_missing_throttling_is_reported(self) -> None:
        template = passing_template()
        del template["Resources"]["HttpApiStage"]["Properties"]["DefaultRouteSettings"]
        self.assertIn("API_THROTTLING", {finding.rule for finding in self.validate(template)})

    def test_dynamodb_recovery_controls_are_reported(self) -> None:
        template = passing_template()
        table = template["Resources"]["RecordsTable"]
        table["DeletionPolicy"] = "Delete"
        table["Properties"]["PointInTimeRecoverySpecification"][
            "PointInTimeRecoveryEnabled"
        ] = False
        self.assertTrue(
            {"DDB_PITR", "DDB_RETAIN"}.issubset(
                {finding.rule for finding in self.validate(template)}
            )
        )

    def test_stale_lambda_selector_is_reported(self) -> None:
        findings = golden_path.validate(
            copy.deepcopy(passing_template()),
            lambda_alias_selectors=("^missing-function$",),
        )
        self.assertIn("LAMBDA_ALIAS_SELECTOR", {finding.rule for finding in findings})


if __name__ == "__main__":
    unittest.main()
