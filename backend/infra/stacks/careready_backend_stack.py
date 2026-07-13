import os

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
)
from aws_cdk import aws_apigatewayv2 as apigwv2
from aws_cdk import aws_apigatewayv2_authorizers as apigwv2_auth
from aws_cdk import aws_apigatewayv2_integrations as apigwv2_int
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from constructs import Construct

# Lambda ソース(backend/src)への相対パス
_SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "src")


class CareReadyBackendStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # --- DynamoDB シングルテーブル ---
        table = dynamodb.Table(
            self,
            "MainTable",
            table_name="careready-main",
            partition_key=dynamodb.Attribute(
                name="PK", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(
                name="SK", type=dynamodb.AttributeType.STRING
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            removal_policy=RemovalPolicy.RETAIN,
        )
        # GSI1: shareCode 解決用(PK=CODE#<shareCode>)
        table.add_global_secondary_index(
            index_name="GSI1",
            partition_key=dynamodb.Attribute(
                name="GSI1PK", type=dynamodb.AttributeType.STRING
            ),
            projection_type=dynamodb.ProjectionType.ALL,
        )

        # --- Cognito(施設スタッフ用)---
        user_pool = cognito.UserPool(
            self,
            "FacilityUserPool",
            user_pool_name="careready-facility",
            self_sign_up_enabled=False,  # 管理者がユーザー作成
            sign_in_aliases=cognito.SignInAliases(email=True),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            standard_attributes=cognito.StandardAttributes(
                email=cognito.StandardAttribute(required=True, mutable=True),
            ),
            custom_attributes={
                "facilityId": cognito.StringAttribute(mutable=True),
            },
            password_policy=cognito.PasswordPolicy(
                min_length=8,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
            ),
            removal_policy=RemovalPolicy.RETAIN,
        )
        user_pool_client = user_pool.add_client(
            "FacilityUserPoolClient",
            user_pool_client_name="careready-facility-web",
            auth_flows=cognito.AuthFlow(
                user_password=True,
                user_srp=True,
            ),
            access_token_validity=Duration.hours(1),
            id_token_validity=Duration.hours(1),
            refresh_token_validity=Duration.days(30),
        )

        # --- Lambda(単一関数+内部ルーター、boto3のみ=バンドル不要)---
        fn = lambda_.Function(
            self,
            "ApiFunction",
            function_name="careready-api",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="handler.lambda_handler",
            code=lambda_.Code.from_asset(_SRC_DIR),
            timeout=Duration.seconds(10),
            memory_size=256,
            environment={
                "TABLE_NAME": table.table_name,
                "GSI1_NAME": "GSI1",
            },
        )
        table.grant_read_write_data(fn)

        # --- API Gateway (HTTP API) ---
        cors = apigwv2.CorsPreflightOptions(
            allow_origins=["https://veai.jp", "http://localhost:8000"],
            allow_methods=[apigwv2.CorsHttpMethod.ANY],
            allow_headers=["content-type", "authorization"],
            max_age=Duration.hours(1),
        )
        http_api = apigwv2.HttpApi(
            self,
            "HttpApi",
            api_name="careready-api",
            cors_preflight=cors,
        )

        integration = apigwv2_int.HttpLambdaIntegration("ApiIntegration", fn)

        jwt_authorizer = apigwv2_auth.HttpUserPoolAuthorizer(
            "CognitoAuthorizer",
            user_pool,
            user_pool_clients=[user_pool_client],
        )

        # 公開ルート(redeem)
        http_api.add_routes(
            path="/v1/templates/redeem",
            methods=[apigwv2.HttpMethod.POST],
            integration=integration,
        )
        # 施設テンプレ CRUD(Cognito JWT オーソライザー)
        http_api.add_routes(
            path="/v1/facility/templates",
            methods=[apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
            integration=integration,
            authorizer=jwt_authorizer,
        )
        http_api.add_routes(
            path="/v1/facility/templates/{tplId}",
            methods=[
                apigwv2.HttpMethod.GET,
                apigwv2.HttpMethod.PUT,
                apigwv2.HttpMethod.DELETE,
            ],
            integration=integration,
            authorizer=jwt_authorizer,
        )

        # --- Outputs ---
        CfnOutput(self, "ApiUrl", value=http_api.api_endpoint)
        CfnOutput(self, "UserPoolId", value=user_pool.user_pool_id)
        CfnOutput(
            self, "UserPoolClientId", value=user_pool_client.user_pool_client_id
        )
        CfnOutput(self, "TableName", value=table.table_name)
