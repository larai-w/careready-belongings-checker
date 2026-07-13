#!/usr/bin/env python3
import aws_cdk as cdk

from stacks.careready_backend_stack import CareReadyBackendStack

app = cdk.App()

CareReadyBackendStack(
    app,
    "CareReadyBackendStack",
    env=cdk.Environment(region="ap-northeast-1"),
)

app.synth()
