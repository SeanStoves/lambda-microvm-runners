import * as pulumi from "@pulumi/pulumi";
import * as pulumiservice from "@pulumi/pulumiservice";

export interface PulumiCloudArgs {
  githubOrg: string;
  githubRepo: string;
  pulumiOrg: string;
  pulumiProject: string;
  // undefined = no Slack webhook gets created
  slackNotificationUrl?: pulumi.Input<string>;
  stackName: string;
}

export function createPulumiCloud(args: PulumiCloudArgs) {
  const deploymentSettings = new pulumiservice.DeploymentSettings(
    "deploymentSettings",
    {
      cacheOptions: {
        enable: true,
      },
      organization: args.pulumiOrg,
      project: args.pulumiProject,
      sourceContext: {
        git: {
          branch: "main",
        },
      },
      stack: args.stackName,
      vcs: {
        deployCommits: false,
        // pulumi-preview.yml already previews every PR, don't do it twice
        previewPullRequests: false,
        provider: "github",
        repository: `${args.githubOrg}/${args.githubRepo}`,
      },
    },
  );

  const driftSchedule = new pulumiservice.DriftSchedule(
    "driftSchedule",
    {
      organization: args.pulumiOrg,
      project: args.pulumiProject,
      scheduleCron: "0 14 * * *", // 2:00pm UTC = 6:00am PST = 8:00am CST = 9:00am EST = 3:00pm CET
      stack: args.stackName,
      autoRemediate: false,
    },
    {
      dependsOn: [deploymentSettings],
    },
  );

  if (!args.slackNotificationUrl) {
    return { deploymentSettings, driftSchedule, webhook: undefined };
  }

  const webhook = new pulumiservice.Webhook("webhook", {
    active: true,
    displayName: `${args.pulumiProject}-slack-notifications`,
    filters: [
      pulumiservice.WebhookFilters.DeploymentFailed,
      pulumiservice.WebhookFilters.DestroyFailed,
      pulumiservice.WebhookFilters.DriftDetected,
      pulumiservice.WebhookFilters.DriftDetectionFailed,
      pulumiservice.WebhookFilters.DriftRemediationFailed,
      pulumiservice.WebhookFilters.RefreshFailed,
      pulumiservice.WebhookFilters.UpdateFailed,
      // Failures only. Full list lives at
      // https://www.pulumi.com/registry/packages/pulumiservice/api-docs/webhook/#webhookfilters
      // The UI has a couple of checkboxes the provider doesn't expose (policy violations,
      // for one), so those aren't here.
    ],
    format: pulumiservice.WebhookFormat.Slack,
    organizationName: args.pulumiOrg,
    payloadUrl: args.slackNotificationUrl,
    projectName: args.pulumiProject,
    stackName: args.stackName,
  });

  return {
    deploymentSettings,
    driftSchedule,
    webhook,
  };
}
