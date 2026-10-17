import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export const config = new pulumi.Config();

// The one account this stack is allowed to touch. Anything else gets refused below.
export const AWS_ACCOUNT_ID = config.require("awsAccountId");
export const AWS_REGION = new pulumi.Config("aws").require("region");
const ALLOWED_STACK = "sbx";

// sbx only, on purpose. If someone tries to stand up dev/stg/prd off a POC, die here
// before a single resource gets declared.
if (pulumi.getStack() !== ALLOWED_STACK) {
  throw new Error(
    `This project only supports the "${ALLOWED_STACK}" stack; refusing stack "${pulumi.getStack()}".`,
  );
}

// Default AWS profile pointed at prod is one typo away on every laptop. Check who we
// actually are and bail if it's not the sandbox. Throwing inside apply() kills the run
// during preview too, so you find out before anything gets created, not after.
function assertSandboxAccount(provider: aws.Provider): void {
  aws.getCallerIdentityOutput({}, { provider }).accountId.apply((accountId) => {
    if (accountId !== AWS_ACCOUNT_ID) {
      throw new Error(
        `This project deploys ONLY to the configured sandbox account (${AWS_ACCOUNT_ID}); refusing account ${accountId}.`,
      );
    }
  });
}

export const NAME_PREFIX = "sbx-gha-runner";
export const ROLE_PREFIX = "sbx-gha-runner";

export interface StackConfig {
  env: string;
  githubOrg: string;
  githubRepo: string;
  pulumiNotificationsSlackChannel: string;
  pulumiOrg: string;
  service: string;
  team: string;
  teamSlack: string;
  githubAppClientId: string;
  githubAppInstallationId: number;
  datadogEnabled: boolean;
  pulumiDeploymentsEnabled: boolean;
  vpcEnabled: boolean;
}

export const stackConfig: StackConfig = {
  env: pulumi.getStack(),
  githubOrg: config.require("githubOrg"),
  githubRepo: config.require("githubRepo"),
  pulumiNotificationsSlackChannel: config.require(
    "pulumiNotificationsSlackChannel",
  ),
  pulumiOrg: config.require("pulumiOrg"),
  service: config.require("service"),
  team: config.require("team"),
  teamSlack: config.require("teamSlack"),
  githubAppClientId: config.require("githubAppClientId"),
  githubAppInstallationId: config.requireNumber("githubAppInstallationId"),
  datadogEnabled: config.getBoolean("datadogEnabled") ?? false,
  // Pulumi Cloud Deployments + drift detection cost money, so they're opt-in
  pulumiDeploymentsEnabled:
    config.getBoolean("pulumiDeploymentsEnabled") ?? false,
  // VPC + NAT + flow logs. Off by default because the NAT gateway alone is ~$32/mo
  // sitting idle, and the Lambdas only ever talk to public GitHub/AWS APIs anyway.
  vpcEnabled: config.getBoolean("vpcEnabled") ?? false,
};

export interface SecretConfig {
  pulumiNotificationsSlackUrl?: pulumi.Output<string>;
  webhookSecret: pulumi.Output<string>;
  githubAppPrivateKey: pulumi.Output<string>;
}

export const secretConfig: SecretConfig = {
  // Optional map of slack channel -> webhook url, if your ESC environment provides one.
  // No map, no Slack notifications. Nothing else cares.
  pulumiNotificationsSlackUrl: config
    .getSecretObject<Record<string, string>>("slack-notifications-webhook-urls")
    ?.apply((urls) => {
      const url = urls[stackConfig.pulumiNotificationsSlackChannel];

      if (!url) {
        throw new Error(
          `Missing Slack webhook URL for channel "${stackConfig.pulumiNotificationsSlackChannel}"`,
        );
      }

      return url;
    }),
  webhookSecret: config.requireSecret("webhookSecret"),
  githubAppPrivateKey: config.requireSecret("githubAppPrivateKey"),
};

export const awsProvider = new aws.Provider("aws", {
  defaultTags: {
    tags: {
      Environment: stackConfig.env,
      Service: stackConfig.service,
      Product: stackConfig.service,
      Team: stackConfig.team,
      TeamSlack: stackConfig.teamSlack,
      RepositoryUrl: `https://github.com/${stackConfig.githubOrg}/${stackConfig.githubRepo}`,
      Provisioner: "pulumi",
      // so you can find every last piece of this when it's time to tear it down
      Project: "lambda-microvm-runners",
    },
  },
});

assertSandboxAccount(awsProvider);
