import os

from aws_cdk import (
    BundlingOptions,
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
from aws_cdk import aws_events as events
from aws_cdk import aws_events_targets as targets
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_secretsmanager as secretsmanager
from aws_cdk import aws_sns as sns
from constructs import Construct

# Lambda ソースへの相対パス
_SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "src")
_PUSH_SENDER_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "push_sender")


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

        ocr_provider = os.environ.get("OCR_PROVIDER", "openai").lower()
        openai_secret_name = os.environ.get(
            "OPENAI_API_KEY_SECRET_NAME", "careready/openai-api-key"
        )
        openai_secret = secretsmanager.Secret.from_secret_name_v2(
            self,
            "OpenAiApiKeySecret",
            openai_secret_name,
        )

        # --- Lambda(単一関数+内部ルーター、boto3のみ=バンドル不要)---
        fn = lambda_.Function(
            self,
            "ApiFunction",
            function_name="careready-api",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="handler.lambda_handler",
            code=lambda_.Code.from_asset(_SRC_DIR),
            timeout=Duration.seconds(20),
            memory_size=256,
            environment={
                "TABLE_NAME": table.table_name,
                "GSI1_NAME": "GSI1",
                "OCR_PROVIDER": ocr_provider,
                "OCR_MAX_BYTES": str(4 * 1024 * 1024),
                "OCR_DAILY_LIMIT": os.environ.get("OCR_DAILY_LIMIT", "20"),
                "OPENAI_OCR_MODEL": os.environ.get("OPENAI_OCR_MODEL", "gpt-5.6-luna"),
                "OPENAI_API_KEY_SECRET_ID": openai_secret_name,
                "TEXTRACT_REGION": os.environ.get("TEXTRACT_REGION", "us-east-1"),
            },
        )
        table.grant_read_write_data(fn)
        openai_secret.grant_read(fn)
        if ocr_provider == "textract":
            fn.add_to_role_policy(
                iam.PolicyStatement(
                    actions=["textract:DetectDocumentText"],
                    resources=["*"],
                )
            )

        # --- フィードバック通知(SNS: 届いた声をメールに) ---
        feedback_topic = sns.Topic(
            self, "FeedbackTopic", topic_name="careready-feedback"
        )
        feedback_topic.grant_publish(fn)
        fn.add_environment("FEEDBACK_TOPIC_ARN", feedback_topic.topic_arn)
        CfnOutput(self, "FeedbackTopicArn", value=feedback_topic.topic_arn)

        # --- 予定リマインドの送信(毎日・Web Push) ---
        vapid_secret = secretsmanager.Secret.from_secret_name_v2(
            self, "VapidPrivateKey", "careready/vapid-private-key"
        )
        push_sender = lambda_.Function(
            self,
            "PushSender",
            function_name="careready-push-sender",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="sender.handler",
            code=lambda_.Code.from_asset(
                _PUSH_SENDER_DIR,
                bundling=BundlingOptions(
                    image=lambda_.Runtime.PYTHON_3_12.bundling_image,
                    command=[
                        "bash",
                        "-c",
                        "pip install -r requirements.txt -t /asset-output && cp -au . /asset-output",
                    ],
                ),
            ),
            timeout=Duration.seconds(120),
            memory_size=256,
            environment={
                "TABLE_NAME": table.table_name,
                "VAPID_SECRET_NAME": "careready/vapid-private-key",
                "VAPID_SUBJECT": "mailto:info@veai.jp",
            },
        )
        table.grant_read_write_data(push_sender)
        vapid_secret.grant_read(push_sender)
        # 毎日 JST 09:00 (UTC 00:00) に確認プッシュを送る
        events.Rule(
            self,
            "PushDailyRule",
            schedule=events.Schedule.cron(hour="0", minute="0"),
            targets=[targets.LambdaFunction(push_sender)],
        )

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
        # 公開ルート(OCR): 画像は保存せず、候補抽出だけを返す。
        http_api.add_routes(
            path="/v1/ocr/items",
            methods=[apigwv2.HttpMethod.POST],
            integration=integration,
        )
        # 公開ルート(フィードバック): アプリ内フォームからのご意見を保存。
        http_api.add_routes(
            path="/v1/feedback",
            methods=[apigwv2.HttpMethod.POST],
            integration=integration,
        )
        # 公開ルート(プッシュ購読): 予定リマインドの購読/解除。
        http_api.add_routes(
            path="/v1/push/subscribe",
            methods=[apigwv2.HttpMethod.POST],
            integration=integration,
        )
        http_api.add_routes(
            path="/v1/push/unsubscribe",
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
