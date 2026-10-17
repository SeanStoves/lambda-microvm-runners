import { createHmac, timingSafeEqual } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

interface WorkflowJobPayload {
  action?: string;
  workflow_job?: {
    id?: number;
    run_id?: number;
    labels?: string[];
  };
  repository?: {
    name?: string;
    full_name?: string;
    owner?: { login?: string };
  };
}

// HTTP API v2 lowercases every header name for us, so a straight lookup is enough
function getHeader(
  headers: APIGatewayProxyEventV2["headers"],
  name: string,
): string | undefined {
  return headers?.[name.toLowerCase()];
}

function getRawBody(event: APIGatewayProxyEventV2): Buffer {
  const body = event.body ?? "";
  return event.isBase64Encoded
    ? Buffer.from(body, "base64")
    : Buffer.from(body, "utf8");
}

function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const receivedHex = signatureHeader.slice("sha256=".length);
  const expectedHex = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const receivedBuf = Buffer.from(receivedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  // timingSafeEqual throws on mismatched lengths instead of returning false. Thanks, Node.
  if (receivedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(receivedBuf, expectedBuf);
}

function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const secretsClient = new SecretsManagerClient({});
const sqsClient = new SQSClient({});

async function fetchWebhookSecret(): Promise<string> {
  const secretArn = process.env.WEBHOOK_SECRET_ARN;
  if (!secretArn) {
    throw new Error("WEBHOOK_SECRET_ARN is not set");
  }
  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!result.SecretString) {
    throw new Error("webhook secret has no SecretString value");
  }
  return result.SecretString;
}

// cached for the life of the container. Rotate the secret and old containers keep the
// old one until Lambda recycles them, so rotate with overlap
let cachedSecret: string | undefined;

async function loadWebhookSecret(): Promise<string> {
  if (cachedSecret) {
    return cachedSecret;
  }
  cachedSecret = await fetchWebhookSecret();
  return cachedSecret;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const githubEvent = getHeader(event.headers, "x-github-event");
  const deliveryId = getHeader(event.headers, "x-github-delivery") ?? "";

  let webhookSecret: string;
  try {
    webhookSecret = await loadWebhookSecret();
  } catch (err) {
    // don't cache a failure, next request tries again
    console.log({
      decision: "error",
      reason: "webhook secret unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: "webhook secret unavailable" });
  }

  const rawBody = getRawBody(event);
  const signatureHeader = getHeader(event.headers, "x-hub-signature-256");

  if (!verifySignature(webhookSecret, rawBody, signatureHeader)) {
    console.log({
      decision: "rejected",
      reason: "invalid or missing signature",
      githubEvent,
      deliveryId,
    });
    return jsonResponse(401, { message: "invalid signature" });
  }

  if (!deliveryId) {
    console.log({
      decision: "rejected",
      reason: "missing X-GitHub-Delivery header",
      githubEvent,
    });
    return jsonResponse(400, { error: "missing X-GitHub-Delivery header" });
  }

  if (githubEvent !== "workflow_job") {
    console.log({
      decision: "ignored",
      reason: "unsupported event type",
      githubEvent,
      deliveryId,
    });
    return jsonResponse(200, {
      ignored: `unsupported event type: ${githubEvent ?? "unknown"}`,
    });
  }

  let payload: WorkflowJobPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as WorkflowJobPayload;
  } catch {
    console.log({
      decision: "error",
      reason: "invalid JSON body",
      githubEvent,
      deliveryId,
    });
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  // Pinned repo check. Somebody installs the App somewhere it shouldn't be, or a valid
  // signature shows up for a repo that isn't ours: we don't spend a VM on it. Pulumi sets
  // both env vars. Unset means no check, so don't unset them.
  const expectedOwner = process.env.GITHUB_OWNER;
  const expectedRepo = process.env.GITHUB_REPO;
  if (expectedOwner || expectedRepo) {
    const expectedFullName = `${expectedOwner}/${expectedRepo}`.toLowerCase();
    const actualFullName = payload.repository?.full_name?.toLowerCase();
    if (actualFullName !== expectedFullName) {
      console.log({
        decision: "ignored",
        reason: "repository does not match pinned repository",
        githubEvent,
        deliveryId,
        repository: payload.repository?.full_name,
      });
      return jsonResponse(200, { ignored: "repository does not match pinned repository" });
    }
  }

  const requiredLabel = process.env.REQUIRED_RUNNER_LABEL ?? "lambda-microvms";
  const action = payload.action;
  const labels = payload.workflow_job?.labels ?? [];
  const jobId = payload.workflow_job?.id;
  const runId = payload.workflow_job?.run_id;

  if (action !== "queued" || !labels.includes(requiredLabel)) {
    const reason =
      action !== "queued" ? "action is not queued" : "missing required runner label";
    console.log({
      decision: "ignored",
      reason,
      githubEvent,
      action,
      jobId,
      runId,
      labels,
      deliveryId,
    });
    return jsonResponse(200, { ignored: reason });
  }

  if (typeof jobId !== "number" || typeof runId !== "number") {
    console.log({
      decision: "error",
      reason: "malformed workflow_job payload",
      githubEvent,
      deliveryId,
    });
    return jsonResponse(400, { error: "malformed workflow_job payload" });
  }

  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) {
    console.log({
      decision: "error",
      reason: "QUEUE_URL is not configured",
      deliveryId,
    });
    return jsonResponse(500, { error: "queue not configured" });
  }

  const message = {
    deliveryId,
    jobId,
    runId,
    labels,
  };

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  } catch (err) {
    console.log({
      decision: "error",
      reason: "failed to enqueue message",
      jobId,
      runId,
      deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: "failed to enqueue message" });
  }

  console.log({
    decision: "enqueued",
    githubEvent,
    action,
    jobId,
    runId,
    labels,
    deliveryId,
  });

  return jsonResponse(202, { accepted: true });
};
