#!/usr/bin/env python3
"""Validate rollback and alerting controls in a synthesized CDK template."""

import json
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"CDK security contract failed: {message}")


def references(value: object, logical_id: str) -> bool:
    if isinstance(value, dict):
        if value.get("Ref") == logical_id:
            return True
        return any(references(child, logical_id) for child in value.values())
    if isinstance(value, list):
        return any(references(child, logical_id) for child in value)
    return value == logical_id


def main() -> None:
    template_path = Path(
        sys.argv[1] if len(sys.argv) > 1 else "cdk.out/CareReadyBackendStack.template.json"
    )
    template = json.loads(template_path.read_text(encoding="utf-8"))
    resources = template.get("Resources", {})

    api_functions = [
        logical_id
        for logical_id, resource in resources.items()
        if resource.get("Type") == "AWS::Lambda::Function"
        and resource.get("Properties", {}).get("FunctionName") == "careready-api"
    ]
    if len(api_functions) != 1:
        fail("expected exactly one careready-api function")
    api_function = api_functions[0]

    versions = [
        (logical_id, resource)
        for logical_id, resource in resources.items()
        if resource.get("Type") == "AWS::Lambda::Version"
        and references(resource.get("Properties", {}).get("FunctionName"), api_function)
    ]
    if len(versions) != 1:
        fail("expected one published API Lambda version")
    version_id, version = versions[0]
    if version.get("DeletionPolicy") != "Retain":
        fail("API Lambda version must have DeletionPolicy Retain")
    if version.get("UpdateReplacePolicy") != "Retain":
        fail("API Lambda version must have UpdateReplacePolicy Retain")

    aliases = [
        (logical_id, resource)
        for logical_id, resource in resources.items()
        if resource.get("Type") == "AWS::Lambda::Alias"
        and resource.get("Properties", {}).get("Name") == "prod"
    ]
    if len(aliases) != 1:
        fail("expected exactly one prod Lambda alias")
    alias_id, alias = aliases[0]
    alias_properties = alias.get("Properties", {})
    if not references(alias_properties.get("FunctionName"), api_function):
        fail("prod alias must reference careready-api")
    if not references(alias_properties.get("FunctionVersion"), version_id):
        fail("prod alias must reference the published API version")

    integrations = [
        resource
        for resource in resources.values()
        if resource.get("Type") == "AWS::ApiGatewayV2::Integration"
    ]
    if not integrations or not all(
        references(resource.get("Properties", {}).get("IntegrationUri"), alias_id)
        for resource in integrations
    ):
        fail("every HTTP API integration must invoke the prod alias")

    expected_alarms = {
        "CareReady-ApiLambda-Errors",
        "CareReady-PushSender-Errors",
    }
    alarms = {
        resource.get("Properties", {}).get("AlarmName"): resource
        for resource in resources.values()
        if resource.get("Type") == "AWS::CloudWatch::Alarm"
    }
    if not expected_alarms.issubset(alarms):
        fail("API and push-sender error alarms are required")
    for alarm_name in expected_alarms:
        properties = alarms[alarm_name].get("Properties", {})
        if properties.get("MetricName") != "Errors":
            fail(f"{alarm_name} must monitor Lambda Errors")
        if properties.get("Threshold") != 1:
            fail(f"{alarm_name} threshold must be one error")
        if properties.get("TreatMissingData") != "notBreaching":
            fail(f"{alarm_name} must treat missing data as not breaching")
        if not properties.get("AlarmActions"):
            fail(f"{alarm_name} must have an alarm action")

    print("CDK security contract OK: version, prod alias, integration, alarms")


if __name__ == "__main__":
    main()
