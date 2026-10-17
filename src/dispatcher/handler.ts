import { createSign, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaMicrovmsClient, RunMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Context, SQSEvent, SQSHandler, SQSRecord } from "aws-lambda";

interface DispatchMessage {
  deliveryId: string;
  jobId: number;
  runId: number;
  labels: string[];
}

interface GitHubAppSecret {
  appClientId: string;
  installationId: number;
  privateKey: string;
}

const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const RUN_MICROVM_MAX_ATTEMPTS = 3;
const RUN_MICROVM_RETRY_DELAY_MS = 5000;
// headroom before Lambda pulls the plug, so we still have time to clean up the dedupe row
const SELF_IMPOSED_DEADLINE_BUFFER_MS = 5000;

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

const dynamoClient = new DynamoDBClient({});
const secretsClient = new SecretsManagerClient({});
const microvmsClient = new LambdaMicrovmsClient({});

// cached for the life of the container, same deal as the webhook secret
let cachedAppSecret: GitHubAppSecret | undefined;

function log(stage: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ stage, time: new Date().toISOString(), ...fields }));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DeadlineExceededError extends Error {
  constructor() {
    super("self-imposed deadline exceeded before dispatch completed");
    this.name = "DeadlineExceededError";
  }
}

// If Lambda hard-kills us mid-dispatch, the dedupe row stays claimed, SQS redelivers,
// the retry sees "duplicate" and quietly drops it. The job sits queued in GitHub
// until GitHub gives up on it, and nobody knows why. So we quit on our own terms first, with time left to
// release the row and let the retry actually retry.
async function withDeadline<T>(work: Promise<T>, context: Context): Promise<T> {
  const remainingMs = Math.max(
    context.getRemainingTimeInMillis() - SELF_IMPOSED_DEADLINE_BUFFER_MS,
    0,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError()), remainingMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function dedupeKey(deliveryId: string): string {
  return `delivery#${deliveryId}`;
}

function parseMessage(body: string): DispatchMessage {
  const parsed = JSON.parse(body) as Partial<DispatchMessage>;
  if (
    typeof parsed.deliveryId !== "string" ||
    !parsed.deliveryId ||
    typeof parsed.jobId !== "number" ||
    typeof parsed.runId !== "number" ||
    !Array.isArray(parsed.labels) ||
    !parsed.labels.every((label) => typeof label === "string")
  ) {
    throw new Error("malformed dispatch message");
  }
  return parsed as DispatchMessage;
}

function base64url(input: string | Buffer): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// true = somebody already claimed this delivery, false = it's ours now
async function claimDedupe(deliveryId: string): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS;
  try {
    await dynamoClient.send(
      new PutItemCommand({
        TableName: requireEnv("DEDUPE_TABLE_NAME"),
        Item: {
          pk: { S: dedupeKey(deliveryId) },
          ttl: { N: String(ttl) },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return false;
  } catch (err) {
    if ((err as { name?: string } | undefined)?.name === "ConditionalCheckFailedException") {
      return true;
    }
    throw err;
  }
}

// Best effort. If this fails too, retries get dropped as dupes until the 24h TTL. Logged, at least.
async function deleteDedupe(deliveryId: string): Promise<void> {
  try {
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: requireEnv("DEDUPE_TABLE_NAME"),
        Key: { pk: { S: dedupeKey(deliveryId) } },
      }),
    );
  } catch (err) {
    log("dedupe_delete_failed", { deliveryId, error: errorMessage(err) });
  }
}

async function loadAppSecret(): Promise<GitHubAppSecret> {
  if (cachedAppSecret) {
    return cachedAppSecret;
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: requireEnv("GITHUB_APP_SECRET_ARN") }),
  );
  if (!result.SecretString) {
    throw new Error("github app secret has no SecretString value");
  }
  const parsed = JSON.parse(result.SecretString) as Partial<GitHubAppSecret>;
  if (
    typeof parsed.appClientId !== "string" ||
    typeof parsed.installationId !== "number" ||
    typeof parsed.privateKey !== "string"
  ) {
    throw new Error("github app secret has an unexpected shape");
  }
  cachedAppSecret = parsed as GitHubAppSecret;
  return cachedAppSecret;
}

function mintAppJwt(appSecret: GitHubAppSecret): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appSecret.appClientId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(appSecret.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function fetchInstallationToken(installationId: number, appJwt: string): Promise<string> {
  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`installation token request failed with status ${response.status}`);
  }
  const body = (await response.json()) as { token?: string };
  if (typeof body.token !== "string") {
    throw new Error("installation token response missing token field");
  }
  return body.token;
}

async function generateJitConfig(
  installationToken: string,
  message: DispatchMessage,
): Promise<string> {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const runnerName = `gha-mvm-${message.jobId}-${randomBytes(3).toString("hex")}`;
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runners/generate-jitconfig`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: runnerName,
        runner_group_id: Number(process.env.RUNNER_GROUP_ID ?? "1"),
        labels: message.labels,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`generate-jitconfig request failed with status ${response.status}`);
  }
  const body = (await response.json()) as { encoded_jit_config?: string };
  if (typeof body.encoded_jit_config !== "string") {
    throw new Error("generate-jitconfig response missing encoded_jit_config field");
  }
  return body.encoded_jit_config;
}

function buildRunHookPayload(encodedJitConfig: string): string {
  return gzipSync(Buffer.from(encodedJitConfig, "utf8")).toString("base64");
}

// MICROVM-API: the SDK types these connectors as plain strings and AWS doesn't publish
// a list of the built-in ones. NO_INGRESS / INTERNET_EGRESS are my best read of the
// naming. If RunMicrovm starts rejecting them, look here first.
function buildRunMicrovmCommand(runHookPayload: string): RunMicrovmCommand {
  // Lambda always sets AWS_REGION, so missing means something is very wrong
  const region = requireEnv("AWS_REGION");
  return new RunMicrovmCommand({
    imageIdentifier: requireEnv("MICROVM_IMAGE_IDENTIFIER"),
    executionRoleArn: requireEnv("MICROVM_EXECUTION_ROLE_ARN"),
    // without this a runner that dies at boot just... vanishes. Ship the logs.
    logging: { cloudWatch: { logGroup: "/aws/microvm/gha-runner" } },
    ingressNetworkConnectors: [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:NO_INGRESS`,
    ],
    egressNetworkConnectors: [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    ],
    idlePolicy: {
      // Safety net for a VM that boots and never gets a job: dead in ~5 min, and no
      // resume. Normally app.js kills it way before this, the second the job ends.
      autoResumeEnabled: false,
      maxIdleDurationSeconds: Number(process.env.MICROVM_MAX_IDLE_SECONDS ?? "300"),
      suspendedDurationSeconds: Number(process.env.MICROVM_SUSPENDED_SECONDS ?? "10"),
    },
    maximumDurationInSeconds: Number(process.env.MICROVM_MAX_DURATION_SECONDS ?? "3600"),
    runHookPayload,
  });
}

async function runMicrovmWithRetry(runHookPayload: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RUN_MICROVM_MAX_ATTEMPTS; attempt++) {
    try {
      await microvmsClient.send(buildRunMicrovmCommand(runHookPayload));
      log("microvm_started", { attempt });
      return;
    } catch (err) {
      lastError = err;
      log("microvm_attempt_failed", { attempt, error: errorMessage(err) });
      if (attempt < RUN_MICROVM_MAX_ATTEMPTS) {
        await sleep(RUN_MICROVM_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function processRecord(record: SQSRecord, context: Context): Promise<void> {
  const start = Date.now();

  // bad message or bad config throws on purpose. SQS retries it, then DLQs it.
  const message = parseMessage(record.body);
  log("parsed", { deliveryId: message.deliveryId, jobId: message.jobId, runId: message.runId });

  const isDuplicate = await claimDedupe(message.deliveryId);
  if (isDuplicate) {
    log("duplicate", { deliveryId: message.deliveryId, jobId: message.jobId });
    return;
  }

  try {
    const dispatchWork = (async () => {
      const appSecret = await loadAppSecret();
      const appJwt = mintAppJwt(appSecret);
      log("jwt_minted", { deliveryId: message.deliveryId, elapsedMs: Date.now() - start });

      const installationToken = await fetchInstallationToken(appSecret.installationId, appJwt);
      log("installation_token_fetched", {
        deliveryId: message.deliveryId,
        elapsedMs: Date.now() - start,
      });

      const encodedJitConfig = await generateJitConfig(installationToken, message);
      log("jitconfig_generated", {
        deliveryId: message.deliveryId,
        elapsedMs: Date.now() - start,
      });

      const runHookPayload = buildRunHookPayload(encodedJitConfig);
      await runMicrovmWithRetry(runHookPayload);
    })();

    await withDeadline(dispatchWork, context);

    log("dispatched", {
      deliveryId: message.deliveryId,
      jobId: message.jobId,
      runId: message.runId,
      totalMs: Date.now() - start,
    });
  } catch (err) {
    // release the claim, or the retry thinks it's a dupe and the job never runs
    await deleteDedupe(message.deliveryId);
    log("dispatch_failed", {
      deliveryId: message.deliveryId,
      jobId: message.jobId,
      totalMs: Date.now() - start,
      error: errorMessage(err),
    });
    throw err;
  }
}

export const handler: SQSHandler = async (event: SQSEvent, context: Context): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record, context);
  }
};
