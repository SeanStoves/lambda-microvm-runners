import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {
  AWS_ACCOUNT_ID,
  AWS_REGION,
  NAME_PREFIX,
  ROLE_PREFIX,
  awsProvider,
  config,
  secretConfig,
  stackConfig,
} from "./config";
import type { NetworkResources } from "./network";
import { dispatcherBuildDir, webhookBuildDir } from "./buildLambda";

// MICROVM-API: built the day after launch, before the IAM docs caught up. The action
// names (RunMicrovm / TerminateMicrovm / CreateMicrovmImage / GetMicrovmImage) and the
// microvm-image:* / microvm:* ARN shapes come from the SDK and trial and error, not from
// a published reference. If AWS documents something different, theirs wins.
const MICROVM_IMAGE_ARN_PATTERN = `arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:microvm-image:*`;
const MICROVM_INSTANCE_ARN_PATTERN = `arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:microvm:*`;
const LAMBDA_LOG_GROUP_ARN_PATTERN = `arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda/*`;
// MICROVM-API: the exec role is reachable from inside the job, so it gets its own
// log prefix instead of the /aws/lambda/* free-for-all above.
const MICROVM_EXEC_LOG_GROUP_ARN_PATTERN = `arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/microvm/gha-runner*`;
const MICROVM_EXEC_LOG_STREAM_ARN_PATTERN = `arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/microvm/gha-runner*:*`;

// TODO(datadog): ":latest-ish" is not a real layer version, it's me not looking it up yet.
// Pin real versions from https://docs.datadoghq.com/serverless/libraries_integrations/extension/
// before you flip datadogEnabled on, or the deploy will fail.
const DATADOG_EXTENSION_LAYER_ARN = `arn:aws:lambda:${AWS_REGION}:464622532012:layer:Datadog-Extension-ARM:latest-ish`;
const DATADOG_NODE_LAYER_ARN = `arn:aws:lambda:${AWS_REGION}:464622532012:layer:Datadog-Node22-ARM:latest-ish`;

const lambdaAssumeRolePolicy = aws.iam.getPolicyDocumentOutput({
  statements: [
    {
      actions: ["sts:AssumeRole"],
      principals: [{ type: "Service", identifiers: ["lambda.amazonaws.com"] }],
    },
  ],
});

export interface RunnerResources {
  webhookFunction: aws.lambda.Function;
  webhookQueue: aws.sqs.Queue;
  microvmCodeBucket: aws.s3.Bucket;
  mvmBuildRole: aws.iam.Role;
  mvmExecRole: aws.iam.Role;
  githubOidcRole: aws.iam.Role;
  dedupeTable: aws.dynamodb.Table;
}

// datadogEnabled off (the default) = no layers, no env vars, nothing.
function datadogLambdaExtras(): {
  layers: string[] | undefined;
  environment: Record<string, pulumi.Input<string>>;
} {
  if (!stackConfig.datadogEnabled) {
    return { layers: undefined, environment: {} };
  }

  return {
    layers: [DATADOG_EXTENSION_LAYER_ARN, DATADOG_NODE_LAYER_ARN],
    environment: {
      DD_API_KEY_SECRET_ARN: config.require("datadogApiKeySecretArn"),
      DD_SERVICE: "gha-microvm-runner",
      DD_ENV: stackConfig.env,
      DD_VERSION: config.get("version") ?? "0.0.0-poc",
    },
  };
}

// No network = Lambdas run outside a VPC. Still no inbound, still outbound HTTPS, and
// nothing in here needs private VPC resources, so it's the same blast radius for $0.
export function createRunnerResources(
  network?: NetworkResources,
): RunnerResources {
  const vpcConfig: aws.types.input.lambda.FunctionVpcConfig | undefined =
    network
      ? {
          subnetIds: network.privateSubnetIds,
          securityGroupIds: [network.lambdaSecurityGroup.id],
        }
      : undefined;
  // VPC flavor is basic execution + the ENI perms Lambda needs to attach to subnets
  const execPolicyArn = network
    ? "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
    : "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
  const datadog = datadogLambdaExtras();

  // --------------------------------
  // KMS CMK
  // --------------------------------

  const cmk = new aws.kms.Key(
    `${NAME_PREFIX}-cmk`,
    {
      description: "CMK for GHA MicroVM runner secrets + S3 (sbx)",
      enableKeyRotation: true,
    },
    { provider: awsProvider },
  );

  new aws.kms.Alias(
    `${NAME_PREFIX}-cmk-alias`,
    { name: "alias/sbx-gha-runner", targetKeyId: cmk.keyId },
    { provider: awsProvider },
  );

  // --------------------------------
  // Secrets Manager
  // --------------------------------

  const webhookSecret = new aws.secretsmanager.Secret(
    `${NAME_PREFIX}-webhook-secret`,
    {
      name: "sbx/gha-microvm-runner/webhook-secret",
      kmsKeyId: cmk.arn,
      // Default is a 30 day recovery window, which means destroy + up dies on "already
      // scheduled for deletion" for a month. Sandbox, we don't need the safety net.
      recoveryWindowInDays: 0,
    },
    { provider: awsProvider },
  );

  new aws.secretsmanager.SecretVersion(
    `${NAME_PREFIX}-webhook-secret-version`,
    { secretId: webhookSecret.id, secretString: secretConfig.webhookSecret },
    { provider: awsProvider },
  );

  const githubAppSecret = new aws.secretsmanager.Secret(
    `${NAME_PREFIX}-github-app-secret`,
    {
      name: "sbx/gha-microvm-runner/github-app",
      kmsKeyId: cmk.arn,
      recoveryWindowInDays: 0,
    },
    { provider: awsProvider },
  );

  const githubAppSecretValue = pulumi.jsonStringify({
    appClientId: stackConfig.githubAppClientId,
    installationId: stackConfig.githubAppInstallationId,
    privateKey: secretConfig.githubAppPrivateKey,
  });

  new aws.secretsmanager.SecretVersion(
    `${NAME_PREFIX}-github-app-secret-version`,
    { secretId: githubAppSecret.id, secretString: githubAppSecretValue },
    { provider: awsProvider },
  );

  // --------------------------------
  // SQS (webhook queue + DLQ)
  // --------------------------------

  const webhookDlq = new aws.sqs.Queue(
    `${NAME_PREFIX}-webhook-dlq`,
    {
      name: `${NAME_PREFIX}-webhook-dlq`,
      messageRetentionSeconds: 1209600,
      sqsManagedSseEnabled: true,
    },
    { provider: awsProvider },
  );

  const webhookQueue = new aws.sqs.Queue(
    `${NAME_PREFIX}-webhook-queue`,
    {
      name: `${NAME_PREFIX}-webhook-queue`,
      // AWS wants >= 6x the consumer's timeout (60s). Go lower and messages come back
      // from the dead while the dispatcher is still working on them.
      visibilityTimeoutSeconds: 360,
      sqsManagedSseEnabled: true,
      redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: webhookDlq.arn,
        maxReceiveCount: 3,
      }),
    },
    { provider: awsProvider },
  );

  // --------------------------------
  // DynamoDB dedupe table
  // --------------------------------

  const dedupeTable = new aws.dynamodb.Table(
    `${NAME_PREFIX}-dedupe`,
    {
      name: `${NAME_PREFIX}-dedupe`,
      billingMode: "PAY_PER_REQUEST",
      hashKey: "pk",
      attributes: [{ name: "pk", type: "S" }],
      ttl: { attributeName: "ttl", enabled: true },
    },
    { provider: awsProvider },
  );

  // --------------------------------
  // S3 bucket for MicroVM image code
  // --------------------------------

  const microvmCodeBucket = new aws.s3.Bucket(
    `${NAME_PREFIX}-code-bucket`,
    {
      bucket: `${NAME_PREFIX}-code-${AWS_ACCOUNT_ID}`,
      // every image build drops a zip in here, and S3 won't delete a non-empty bucket.
      // Without this, pulumi destroy just dies on it.
      forceDestroy: true,
    },
    { provider: awsProvider },
  );

  new aws.s3.BucketPublicAccessBlock(
    `${NAME_PREFIX}-code-pab`,
    {
      bucket: microvmCodeBucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    { provider: awsProvider },
  );

  new aws.s3.BucketServerSideEncryptionConfiguration(
    `${NAME_PREFIX}-code-sse`,
    {
      bucket: microvmCodeBucket.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: {
            sseAlgorithm: "aws:kms",
            kmsMasterKeyId: cmk.arn,
          },
          bucketKeyEnabled: true,
        },
      ],
    },
    { provider: awsProvider },
  );

  // --------------------------------
  // IAM: MicroVM build + execution roles
  // --------------------------------

  const mvmBuildRole = new aws.iam.Role(
    `${ROLE_PREFIX}-mvm-build`,
    {
      name: `${ROLE_PREFIX}-mvm-build`,
      description:
        "MICROVM-API: assumed by the MicroVM image build service when it fetches runner code from S3.",
      assumeRolePolicy: lambdaAssumeRolePolicy.json,
    },
    { provider: awsProvider },
  );

  const mvmBuildPolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: ["s3:GetObject"],
        resources: [pulumi.interpolate`${microvmCodeBucket.arn}/*`],
      },
      {
        // bucket is SSE-KMS with the CMK, so no Decrypt = AccessDenied on GetObject
        actions: ["kms:Decrypt"],
        resources: [cmk.arn],
      },
      {
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        // broader than I'd like, but the build service names its own log group per run
        // and doesn't tell you what it'll be ahead of time
        resources: [LAMBDA_LOG_GROUP_ARN_PATTERN],
      },
    ],
  });

  new aws.iam.RolePolicy(
    `${ROLE_PREFIX}-mvm-build-inline`,
    { role: mvmBuildRole.id, policy: mvmBuildPolicyDoc.json },
    { provider: awsProvider },
  );

  const mvmExecRole = new aws.iam.Role(
    `${ROLE_PREFIX}-mvm-exec`,
    {
      name: `${ROLE_PREFIX}-mvm-exec`,
      description:
        "MICROVM-API: execution role passed to the MicroVM control plane when it runs a runner microvm.",
      assumeRolePolicy: lambdaAssumeRolePolicy.json,
    },
    { provider: awsProvider },
  );

  const mvmExecPolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        // MICROVM-API: yes, this means a job can terminate *other* runner VMs. I'd scope
        // it to "only yourself" if the API had a way to say that; it doesn't, that I
        // could find. Worst case is someone kills a sibling job, which is annoying, not a
        // breach.
        // Found out the hard way that TerminateMicrovm authorizes against the IMAGE ARN the
        // VM launched from, not a per-VM ARN. Self-terminate failed until both were here.
        actions: ["lambda:TerminateMicrovm"],
        resources: [MICROVM_IMAGE_ARN_PATTERN, MICROVM_INSTANCE_ARN_PATTERN],
      },
      {
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          MICROVM_EXEC_LOG_GROUP_ARN_PATTERN,
          MICROVM_EXEC_LOG_STREAM_ARN_PATTERN,
        ],
      },
    ],
  });

  new aws.iam.RolePolicy(
    `${ROLE_PREFIX}-mvm-exec-inline`,
    { role: mvmExecRole.id, policy: mvmExecPolicyDoc.json },
    { provider: awsProvider },
  );

  // --------------------------------
  // IAM + Lambda: webhook function
  // --------------------------------

  const webhookRole = new aws.iam.Role(
    `${ROLE_PREFIX}-webhook`,
    {
      name: `${ROLE_PREFIX}-webhook`,
      assumeRolePolicy: lambdaAssumeRolePolicy.json,
    },
    { provider: awsProvider },
  );

  new aws.iam.RolePolicyAttachment(
    `${ROLE_PREFIX}-webhook-exec`,
    { role: webhookRole.name, policyArn: execPolicyArn },
    { provider: awsProvider },
  );

  const webhookPolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      { actions: ["sqs:SendMessage"], resources: [webhookQueue.arn] },
      {
        actions: ["secretsmanager:GetSecretValue"],
        resources: [webhookSecret.arn],
      },
      { actions: ["kms:Decrypt"], resources: [cmk.arn] },
    ],
  });

  new aws.iam.RolePolicy(
    `${ROLE_PREFIX}-webhook-inline`,
    { role: webhookRole.id, policy: webhookPolicyDoc.json },
    { provider: awsProvider },
  );

  const webhookLogGroup = new aws.cloudwatch.LogGroup(
    `${NAME_PREFIX}-webhook-app-logs`,
    { name: `/aws/lambda/${NAME_PREFIX}-webhook-app`, retentionInDays: 7 },
    { provider: awsProvider },
  );

  const webhookFunction = new aws.lambda.Function(
    `${NAME_PREFIX}-webhook-app`,
    {
      name: `${NAME_PREFIX}-webhook-app`,
      role: webhookRole.arn,
      handler: "index.handler",
      runtime: aws.lambda.Runtime.NodeJS22dX,
      architectures: ["arm64"],
      code: new pulumi.asset.FileArchive(webhookBuildDir),
      memorySize: 256,
      timeout: 10,
      vpcConfig,
      layers: datadog.layers,
      environment: {
        variables: {
          WEBHOOK_SECRET_ARN: webhookSecret.arn,
          QUEUE_URL: webhookQueue.url,
          GITHUB_OWNER: stackConfig.githubOrg,
          GITHUB_REPO: stackConfig.githubRepo,
          ...datadog.environment,
        },
      },
    },
    { provider: awsProvider, dependsOn: [webhookLogGroup] },
  );

  // --------------------------------
  // IAM + Lambda: dispatch function
  // --------------------------------

  const dispatchRole = new aws.iam.Role(
    `${ROLE_PREFIX}-dispatch`,
    {
      name: `${ROLE_PREFIX}-dispatch`,
      assumeRolePolicy: lambdaAssumeRolePolicy.json,
    },
    { provider: awsProvider },
  );

  new aws.iam.RolePolicyAttachment(
    `${ROLE_PREFIX}-dispatch-exec`,
    { role: dispatchRole.name, policyArn: execPolicyArn },
    { provider: awsProvider },
  );

  const dispatchPolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ],
        resources: [webhookQueue.arn],
      },
      {
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [dedupeTable.arn],
      },
      {
        actions: ["secretsmanager:GetSecretValue"],
        resources: [githubAppSecret.arn],
      },
      { actions: ["kms:Decrypt"], resources: [cmk.arn] },
      {
        // MICROVM-API: see the module-level comment on MICROVM_IMAGE_ARN_PATTERN.
        actions: ["lambda:RunMicrovm"],
        resources: [MICROVM_IMAGE_ARN_PATTERN],
      },
      {
        // MICROVM-API: no iam:PassedToService condition here, and not because I forgot.
        // RunMicrovm passes the role under some principal that isn't lambda.amazonaws.com,
        // so pinning it to lambda denies the call. It can still only pass this one role.
        // Add the condition back once the real service principal is known.
        actions: ["iam:PassRole"],
        resources: [mvmExecRole.arn],
      },
      {
        // MICROVM-API: I tried scoping this to the exact NO_INGRESS / INTERNET_EGRESS ARNs.
        // Denied, even on an exact match, because they're AWS-owned (account is "aws").
        // "*" it is. The only thing you can pass with this is an AWS-managed connector.
        actions: ["lambda:PassNetworkConnector"],
        resources: ["*"],
      },
    ],
  });

  new aws.iam.RolePolicy(
    `${ROLE_PREFIX}-dispatch-inline`,
    { role: dispatchRole.id, policy: dispatchPolicyDoc.json },
    { provider: awsProvider },
  );

  const dispatchLogGroup = new aws.cloudwatch.LogGroup(
    `${NAME_PREFIX}-dispatch-app-logs`,
    { name: `/aws/lambda/${NAME_PREFIX}-dispatch-app`, retentionInDays: 7 },
    { provider: awsProvider },
  );

  // Chicken and egg: the image gets built after this stack exists, so this can't be
  // config.require(). Unset means the env var is left off entirely, and the dispatcher
  // dies loudly on the first job instead of trying to launch a VM from nothing.
  const microvmImageIdentifier = config.get("microvmImageIdentifier");

  const dispatchFunction = new aws.lambda.Function(
    `${NAME_PREFIX}-dispatch-app`,
    {
      name: `${NAME_PREFIX}-dispatch-app`,
      role: dispatchRole.arn,
      handler: "index.handler",
      runtime: aws.lambda.Runtime.NodeJS22dX,
      architectures: ["arm64"],
      code: new pulumi.asset.FileArchive(dispatcherBuildDir),
      memorySize: 256,
      timeout: 60,
      vpcConfig,
      layers: datadog.layers,
      environment: {
        variables: {
          GITHUB_APP_SECRET_ARN: githubAppSecret.arn,
          GITHUB_OWNER: stackConfig.githubOrg,
          GITHUB_REPO: stackConfig.githubRepo,
          MICROVM_EXECUTION_ROLE_ARN: mvmExecRole.arn,
          DEDUPE_TABLE_NAME: dedupeTable.name,
          ...(microvmImageIdentifier
            ? { MICROVM_IMAGE_IDENTIFIER: microvmImageIdentifier }
            : {}),
          ...datadog.environment,
        },
      },
    },
    { provider: awsProvider, dependsOn: [dispatchLogGroup] },
  );

  new aws.lambda.EventSourceMapping(
    `${NAME_PREFIX}-dispatch-event-source`,
    {
      eventSourceArn: webhookQueue.arn,
      functionName: dispatchFunction.name,
      batchSize: 1,
      // Matches the 5 TPS RunMicrovm quota. Capped here and not with reserved concurrency
      // on purpose: reserved concurrency throttles the Lambda, throttles burn receive
      // counts, and three of those under a burst lands real jobs in the DLQ.
      scalingConfig: {
        maximumConcurrency: 5,
      },
    },
    { provider: awsProvider },
  );

  // --------------------------------
  // GitHub Actions OIDC role
  // --------------------------------

  const oidcPolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: ["s3:PutObject"],
        resources: [pulumi.interpolate`${microvmCodeBucket.arn}/*`],
      },
      {
        // SSE-KMS bucket again: GenerateDataKey to write, Decrypt to read back
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: [cmk.arn],
      },
      {
        // MICROVM-API: see the module-level comment on MICROVM_IMAGE_ARN_PATTERN.
        actions: ["lambda:CreateMicrovmImage", "lambda:GetMicrovmImage"],
        resources: [MICROVM_IMAGE_ARN_PATTERN],
      },
      {
        actions: ["iam:PassRole"],
        resources: [mvmBuildRole.arn],
        conditions: [
          {
            test: "StringEquals",
            variable: "iam:PassedToService",
            values: ["lambda.amazonaws.com"],
          },
        ],
      },
    ],
  });

  // Lookup, not create. You get one GitHub OIDC provider per account and odds are you
  // already have it, in which case creating one dies with EntityAlreadyExists. Don't have
  // one? Make it once by hand before the first pulumi up.
  const githubOidcProvider = aws.iam.getOpenIdConnectProviderOutput(
    { url: "https://token.actions.githubusercontent.com" },
    { provider: awsProvider },
  );

  const githubOidcAssumeRolePolicyDoc = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: ["sts:AssumeRoleWithWebIdentity"],
        principals: [
          {
            type: "Federated",
            identifiers: [githubOidcProvider.apply((p) => p.arn)],
          },
        ],
        conditions: [
          {
            test: "StringEquals",
            variable: "token.actions.githubusercontent.com:aud",
            values: ["sts.amazonaws.com"],
          },
          {
            // main only. No branch or PR has any business publishing runner images.
            test: "StringLike",
            variable: "token.actions.githubusercontent.com:sub",
            values: [
              pulumi.interpolate`repo:${stackConfig.githubOrg}/${stackConfig.githubRepo}:ref:refs/heads/main`,
            ],
          },
        ],
      },
    ],
  });

  const githubOidcRole = new aws.iam.Role(
    `${ROLE_PREFIX}-github-oidc`,
    {
      name: "lambda-microvm-runners-github-oidc",
      description: `GitHub Actions OIDC role for ${stackConfig.githubOrg}/${stackConfig.githubRepo} (builds + publishes MicroVM runner images).`,
      assumeRolePolicy: githubOidcAssumeRolePolicyDoc.json,
    },
    { provider: awsProvider },
  );

  new aws.iam.RolePolicy(
    `${ROLE_PREFIX}-github-oidc-inline`,
    { role: githubOidcRole.id, policy: oidcPolicyDoc.json },
    { provider: awsProvider },
  );

  return {
    webhookFunction,
    webhookQueue,
    microvmCodeBucket,
    mvmBuildRole,
    mvmExecRole,
    githubOidcRole,
    dedupeTable,
  };
}
