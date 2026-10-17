#!/usr/bin/env npx tsx
/*
 * Build + register the runner MicroVM image
 * Author: Sean Stoves
 *
 * Check we're in the sandbox account, zip microvm/, ship it to S3, call
 * CreateMicrovmImage, and poll until it's CREATED or blows up.
 *
 * Image ARN is the LAST line of stdout:
 *   image=$(npx tsx scripts/build-microvm-image.ts | tail -n1)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;


function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getGitSha(): string {
  const fromEnv = process.env.GITHUB_SHA;
  if (fromEnv) {
    return fromEnv.slice(0, 7);
  }
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function buildMicrovmZip(microvmDir: string, zipPath: string): void {
  if (existsSync(zipPath)) {
    rmSync(zipPath);
  }

  console.log(`Zipping ${microvmDir} -> ${zipPath}`);
  // needs the zip CLI. GitHub's ubuntu images have it, your laptop might not
  execFileSync("zip", ["-rq", zipPath, "."], {
    cwd: microvmDir,
    stdio: "inherit",
  });
}

async function uploadZip(bucket: string, key: string, zipPath: string): Promise<void> {
  console.log(`Uploading ${zipPath} to s3://${bucket}/${key}`);
  const s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readFileSync(zipPath),
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This uploads to S3 and builds real images. Your default profile pointed at prod
// should never get that far. No AWS_ACCOUNT_ID set means no run, not "close enough".
async function assertSandboxAccount(allowedAccountId: string): Promise<void> {
  const sts = new STSClient({});
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (identity.Account !== allowedAccountId) {
    console.error(
      `This script targets ONLY the configured sandbox account (${allowedAccountId}); ` +
        `current credentials are for ${identity.Account ?? "an unknown account"}.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await assertSandboxAccount(requireEnv("AWS_ACCOUNT_ID"));

  const bucket = requireEnv("MICROVM_CODE_BUCKET");
  const buildRoleArn = requireEnv("MICROVM_BUILD_ROLE_ARN");
  // al2023-1 was the only managed base image at launch. ListManagedMicrovmImages if
  // you want to see what else there is now.
  const microvms = new LambdaMicrovmsClient({});
  // whatever region the SDK resolved: AWS_REGION in CI, your profile locally
  const region = await microvms.config.region();
  const baseImageArn =
    process.env.MICROVM_BASE_IMAGE_ARN ?? `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;

  const repoRoot = process.cwd();
  const microvmDir = path.join(repoRoot, "microvm");
  const gitSha = getGitSha();
  const imageName = `gha-runner-${gitSha}`;
  const zipPath = path.join(repoRoot, "app.zip");
  const key = `${imageName}/app.zip`;

  buildMicrovmZip(microvmDir, zipPath);
  await uploadZip(bucket, key, zipPath);

  console.log(`Creating MicroVM image ${imageName}`);
  // MICROVM-API: the SDK says "an Amazon S3 path" and stops there. s3://bucket/key is
  // what everything else in AWS takes, so that's what this sends.
  const createResponse = await microvms.send(
    new CreateMicrovmImageCommand({
      name: imageName,
      baseImageArn,
      buildRoleArn,
      codeArtifact: { uri: `s3://${bucket}/${key}` },
      // Forget this and RunMicrovm rejects the payload with "The run hook must be
      // enabled in the MicroVM image to pass the run hook payload". Ask me how I know.
      // Paths are fixed by AWS, we only turn them on and set timeouts.
      hooks: {
        port: 9000,
        microvmImageHooks: {
          ready: "ENABLED",
          readyTimeoutInSeconds: 180,
        },
        microvmHooks: {
          run: "ENABLED",
          runTimeoutInSeconds: 30,
          terminate: "ENABLED",
          terminateTimeoutInSeconds: 30,
        },
      },
      // Pulumi's defaultTags don't reach things the SDK creates, so tag it by hand or
      // it gets orphaned at teardown
      tags: {
        Environment: "sbx",
        Service: "gha-microvm-runner",
        ...(process.env.GITHUB_REPOSITORY
          ? { RepositoryUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}` }
          : {}),
        Provisioner: "manual",
        Project: "lambda-microvm-runners",
      },
    }),
  );

  const imageArn = createResponse.imageArn;
  if (!imageArn) {
    throw new Error("CreateMicrovmImageCommand did not return an imageArn");
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let state = createResponse.state;

  while (state !== "CREATED" && state !== "CREATE_FAILED") {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after 20 minutes waiting for image ${imageName} to become CREATED`,
      );
    }
    await sleep(POLL_INTERVAL_MS);

    const getResponse = await microvms.send(
      new GetMicrovmImageCommand({ imageIdentifier: imageArn }),
    );
    state = getResponse.state;
    console.log(`Image ${imageName} status: ${state}`);
  }

  if (state === "CREATE_FAILED") {
    throw new Error(`MicroVM image build failed for ${imageName}`);
  }

  console.log(imageArn);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
