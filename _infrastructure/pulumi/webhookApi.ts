import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { NAME_PREFIX, awsProvider } from "./config";

export interface WebhookApiResources {
  apiEndpoint: pulumi.Output<string>;
}

export function createWebhookApi(
  webhookFunction: aws.lambda.Function,
): WebhookApiResources {
  const api = new aws.apigatewayv2.Api(
    `${NAME_PREFIX}-webhook-api`,
    { name: `${NAME_PREFIX}-webhook-api`, protocolType: "HTTP" },
    { provider: awsProvider },
  );

  const integration = new aws.apigatewayv2.Integration(
    `${NAME_PREFIX}-webhook-integration`,
    {
      apiId: api.id,
      integrationType: "AWS_PROXY",
      integrationUri: webhookFunction.arn,
      payloadFormatVersion: "2.0",
    },
    { provider: awsProvider },
  );

  new aws.apigatewayv2.Route(
    `${NAME_PREFIX}-webhook-route`,
    {
      apiId: api.id,
      routeKey: "POST /webhook",
      target: pulumi.interpolate`integrations/${integration.id}`,
    },
    { provider: awsProvider },
  );

  new aws.apigatewayv2.Stage(
    `${NAME_PREFIX}-webhook-stage`,
    {
      apiId: api.id,
      name: "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: 10,
        throttlingRateLimit: 5,
      },
    },
    { provider: awsProvider },
  );

  new aws.lambda.Permission(
    `${NAME_PREFIX}-webhook-invoke-permission`,
    {
      action: "lambda:InvokeFunction",
      function: webhookFunction.name,
      principal: "apigateway.amazonaws.com",
      // this API only, not "anything in API Gateway can invoke me"
      sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
    },
    { provider: awsProvider },
  );

  return {
    apiEndpoint: pulumi.interpolate`${api.apiEndpoint}/webhook`,
  };
}
