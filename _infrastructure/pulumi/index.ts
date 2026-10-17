import * as pulumi from "@pulumi/pulumi";
import { secretConfig, stackConfig } from "./config";
import { createPulumiCloud } from "./pulumiCloud";
import { createNetwork } from "./network";
import { createRunnerResources } from "./runners";
import { createWebhookApi } from "./webhookApi";

// --------------------------------
// Resources
// --------------------------------

export const pulumiCloud = stackConfig.pulumiDeploymentsEnabled
  ? createPulumiCloud({
      githubOrg: stackConfig.githubOrg,
      githubRepo: stackConfig.githubRepo,
      pulumiOrg: stackConfig.pulumiOrg,
      // has to be the Pulumi.yaml project name, not the service tag, or
      // DeploymentSettings 404s
      pulumiProject: pulumi.getProject(),
      slackNotificationUrl: secretConfig.pulumiNotificationsSlackUrl,
      stackName: stackConfig.env,
    })
  : undefined;

const network = stackConfig.vpcEnabled ? createNetwork() : undefined;
const runners = createRunnerResources(network);
const webhookApi = createWebhookApi(runners.webhookFunction);

// --------------------------------
// Stack outputs
// --------------------------------

export const webhookUrl = webhookApi.apiEndpoint;
export const queueUrl = runners.webhookQueue.url;
export const microvmCodeBucket = runners.microvmCodeBucket.bucket;
export const microvmBuildRoleArn = runners.mvmBuildRole.arn;
export const microvmExecutionRoleArn = runners.mvmExecRole.arn;
export const githubOidcRoleArn = runners.githubOidcRole.arn;
export const dedupeTableName = runners.dedupeTable.name;
