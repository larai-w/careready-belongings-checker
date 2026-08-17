#!/usr/bin/env python3
"""Report shared VEAI safety controls in synthesized CloudFormation JSON."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class Finding:
    rule: str
    resource: str
    message: str


def references(value: object, logical_id: str) -> bool:
    if isinstance(value, dict):
        if value.get("Ref") == logical_id:
            return True
        get_att = value.get("Fn::GetAtt")
        if isinstance(get_att, list) and get_att and get_att[0] == logical_id:
            return True
        if isinstance(get_att, str) and get_att.split(".", 1)[0] == logical_id:
            return True
        return any(references(child, logical_id) for child in value.values())
    if isinstance(value, list):
        return any(references(child, logical_id) for child in value)
    return value == logical_id


def values(value: object) -> list[object]:
    return value if isinstance(value, list) else [value]


def policy_statements(resource: dict[str, Any]) -> Iterable[dict[str, Any]]:
    properties = resource.get("Properties", {})
    if resource.get("Type") == "AWS::IAM::Policy":
        yield from properties.get("PolicyDocument", {}).get("Statement", [])
    if resource.get("Type") == "AWS::IAM::Role":
        for policy in properties.get("Policies", []):
            yield from policy.get("PolicyDocument", {}).get("Statement", [])


def validate(
    template: dict[str, Any],
    *,
    lambda_alias_selectors: tuple[str, ...] = (),
    require_api_throttling: bool = False,
) -> list[Finding]:
    resources = template.get("Resources")
    if not isinstance(resources, dict):
        return [Finding("TEMPLATE_RESOURCES", "<template>", "Resources must be an object")]

    findings: list[Finding] = []
    required_public_block = {
        "BlockPublicAcls",
        "BlockPublicPolicy",
        "IgnorePublicAcls",
        "RestrictPublicBuckets",
    }

    for logical_id, resource in resources.items():
        resource_type = resource.get("Type")
        properties = resource.get("Properties", {})

        if resource_type == "AWS::S3::Bucket":
            block = properties.get("PublicAccessBlockConfiguration", {})
            missing = sorted(key for key in required_public_block if block.get(key) is not True)
            if missing:
                findings.append(Finding(
                    "S3_PUBLIC_ACCESS_BLOCK",
                    logical_id,
                    "must set all four public-access block controls to true: "
                    + ", ".join(missing),
                ))

        if resource_type == "AWS::DynamoDB::Table":
            pitr = properties.get("PointInTimeRecoverySpecification", {})
            if pitr.get("PointInTimeRecoveryEnabled") is not True:
                findings.append(Finding(
                    "DDB_PITR", logical_id, "must enable point-in-time recovery"
                ))
            if (
                resource.get("DeletionPolicy") != "Retain"
                or resource.get("UpdateReplacePolicy") != "Retain"
            ):
                findings.append(Finding(
                    "DDB_RETAIN",
                    logical_id,
                    "must set DeletionPolicy and UpdateReplacePolicy to Retain",
                ))

        if resource_type == "AWS::Logs::LogGroup":
            retention = properties.get("RetentionInDays")
            if not isinstance(retention, int) or retention <= 0:
                findings.append(Finding(
                    "LOG_RETENTION", logical_id, "must set a positive RetentionInDays"
                ))

        for statement in policy_statements(resource):
            actions = values(statement.get("Action", []))
            allowed_resources = values(statement.get("Resource", []))
            if "*" in actions and "*" in allowed_resources:
                findings.append(Finding(
                    "IAM_ADMIN_WILDCARD",
                    logical_id,
                    "must not allow Action '*' on Resource '*'",
                ))

    if lambda_alias_selectors:
        functions = {
            logical_id: resource
            for logical_id, resource in resources.items()
            if resource.get("Type") == "AWS::Lambda::Function"
        }
        selected_functions: dict[str, dict[str, Any]] = {}
        for selector in lambda_alias_selectors:
            pattern = re.compile(selector)
            matched = {
                logical_id: resource
                for logical_id, resource in functions.items()
                if pattern.search(logical_id)
                or (
                    isinstance(resource.get("Properties", {}).get("FunctionName"), str)
                    and pattern.search(resource["Properties"]["FunctionName"])
                )
            }
            if not matched:
                findings.append(Finding(
                    "LAMBDA_ALIAS_SELECTOR",
                    "<template>",
                    f"selector matched no Lambda function: {selector}",
                ))
            selected_functions.update(matched)

        versions = {
            logical_id: resource
            for logical_id, resource in resources.items()
            if resource.get("Type") == "AWS::Lambda::Version"
        }
        aliases = [
            resource
            for resource in resources.values()
            if resource.get("Type") == "AWS::Lambda::Alias"
            and resource.get("Properties", {}).get("Name") == "prod"
        ]
        for function_id in selected_functions:
            retained_versions = [
                (version_id, version)
                for version_id, version in versions.items()
                if references(version.get("Properties", {}).get("FunctionName"), function_id)
                and version.get("DeletionPolicy") == "Retain"
                and version.get("UpdateReplacePolicy") == "Retain"
            ]
            if not retained_versions or not any(
                references(alias.get("Properties", {}).get("FunctionName"), function_id)
                and any(
                    references(alias.get("Properties", {}).get("FunctionVersion"), version_id)
                    for version_id, _ in retained_versions
                )
                for alias in aliases
            ):
                findings.append(Finding(
                    "LAMBDA_VERSION_ALIAS",
                    function_id,
                    "must have a retained published version and prod alias",
                ))

    if require_api_throttling:
        api_types = {"AWS::ApiGateway::RestApi", "AWS::ApiGatewayV2::Api"}
        has_api = any(resource.get("Type") in api_types for resource in resources.values())
        throttled = False
        for resource in resources.values():
            properties = resource.get("Properties", {})
            if resource.get("Type") == "AWS::ApiGatewayV2::Stage":
                settings = properties.get("DefaultRouteSettings", {})
                throttled = throttled or (
                    isinstance(settings.get("ThrottlingRateLimit"), (int, float))
                    and settings.get("ThrottlingRateLimit") > 0
                    and isinstance(settings.get("ThrottlingBurstLimit"), (int, float))
                    and settings.get("ThrottlingBurstLimit") > 0
                )
            if resource.get("Type") == "AWS::ApiGateway::Stage":
                for settings in properties.get("MethodSettings", []):
                    throttled = throttled or (
                        isinstance(settings.get("ThrottlingRateLimit"), (int, float))
                        and settings.get("ThrottlingRateLimit") > 0
                        and isinstance(settings.get("ThrottlingBurstLimit"), (int, float))
                        and settings.get("ThrottlingBurstLimit") > 0
                    )
        if has_api and not throttled:
            findings.append(Finding(
                "API_THROTTLING",
                "<template>",
                "API Gateway must have positive rate and burst throttling",
            ))

    return findings


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path, help="synthesized CloudFormation JSON")
    parser.add_argument(
        "--lambda-alias-selector",
        action="append",
        default=[],
        metavar="REGEX",
        help="require a retained prod alias for matching Lambda functions; repeatable",
    )
    parser.add_argument("--require-api-throttling", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    template = json.loads(args.template.read_text(encoding="utf-8"))
    try:
        findings = validate(
            template,
            lambda_alias_selectors=tuple(args.lambda_alias_selector),
            require_api_throttling=args.require_api_throttling,
        )
    except re.error as error:
        print(f"Golden Path configuration failed: invalid Lambda selector: {error}")
        return 2

    if findings:
        print("Golden Path findings:")
        for finding in findings:
            print(f"- [{finding.rule}] {finding.resource}: {finding.message}")
        return 1

    print(f"Golden Path report OK: {args.template}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
