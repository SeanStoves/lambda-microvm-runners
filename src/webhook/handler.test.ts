import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const secretsSendMock = vi.fn();
const sqsSendMock = vi.fn();

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: secretsSendMock,
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: sqsSendMock,
  })),
  SendMessageCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

const WEBHOOK_SECRET = "test-webhook-secret";
const REQUIRED_LABEL = "lambda-microvms";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";

function sign(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

// each test that needs a fresh module (e.g. to change env vars or mock responses)
// resets the registry so the lazily-cached secret doesn't leak across tests
async function loadHandler() {
  vi.resetModules();
  process.env.WEBHOOK_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test";
  process.env.QUEUE_URL = QUEUE_URL;
  process.env.REQUIRED_RUNNER_LABEL = REQUIRED_LABEL;
  const mod = await import("./handler.js");
  return mod.handler;
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "queued",
    workflow_job: {
      id: 111,
      run_id: 222,
      labels: [REQUIRED_LABEL],
    },
    repository: {
      name: "lambda-microvm-runners",
      full_name: "ExampleOrg/lambda-microvm-runners",
      owner: { login: "ExampleOrg" },
    },
    ...overrides,
  };
}

function makeEvent(opts: {
  payload: unknown;
  githubEvent?: string;
  deliveryId?: string;
  signWith?: string | null;
}): APIGatewayProxyEventV2 {
  const rawBody = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    "x-github-event": opts.githubEvent ?? "workflow_job",
    "x-github-delivery": opts.deliveryId ?? "delivery-guid-1",
  };
  if (opts.signWith !== null) {
    headers["x-hub-signature-256"] = sign(opts.signWith ?? WEBHOOK_SECRET, rawBody);
  }
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/webhook",
    rawQueryString: "",
    headers,
    body: rawBody,
    isBase64Encoded: false,
    requestContext: {} as never,
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  vi.clearAllMocks();
  // repo-pinning is opt-in per test; make sure it doesn't leak across tests
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  secretsSendMock.mockResolvedValue({ SecretString: WEBHOOK_SECRET });
  sqsSendMock.mockResolvedValue({ MessageId: "sqs-message-id" });
});

describe("webhook handler", () => {
  it("accepts a valid signature and enqueues the job", async () => {
    const handler = await loadHandler();
    const event = makeEvent({ payload: makePayload() });

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 202 });
    expect(sqsSendMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid signature with 401", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload(),
      signWith: "wrong-secret",
    });

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 401 });
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("rejects missing X-GitHub-Delivery header with 400", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload(),
      deliveryId: "",
    });

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 400 });
    expect(JSON.parse(result.body ?? "{}")).toEqual({
      error: "missing X-GitHub-Delivery header",
    });
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("ignores events that are not workflow_job", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload(),
      githubEvent: "push",
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toHaveProperty("ignored");
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("ignores workflow_job events whose action is not queued", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload({ action: "completed" }),
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toHaveProperty("ignored");
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("ignores workflow_job events missing the required runner label", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload({
        workflow_job: { id: 111, run_id: 222, labels: ["self-hosted"] },
      }),
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toHaveProperty("ignored");
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("builds the SQS message in the shared contract shape", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload(),
      deliveryId: "delivery-guid-42",
    });

    await handler(event);

    expect(sqsSendMock).toHaveBeenCalledTimes(1);
    const sentCommand = sqsSendMock.mock.calls[0][0] as {
      input: { QueueUrl: string; MessageBody: string };
    };
    expect(sentCommand.input.QueueUrl).toBe(QUEUE_URL);
    expect(JSON.parse(sentCommand.input.MessageBody)).toEqual({
      deliveryId: "delivery-guid-42",
      jobId: 111,
      runId: 222,
      labels: [REQUIRED_LABEL],
    });
  });

  it("ignores events whose repository doesn't match the pinned GITHUB_OWNER/GITHUB_REPO", async () => {
    process.env.GITHUB_OWNER = "ExampleOrg";
    process.env.GITHUB_REPO = "lambda-microvm-runners";
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload({
        repository: {
          name: "some-other-repo",
          full_name: "SomeoneElse/some-other-repo",
          owner: { login: "SomeoneElse" },
        },
      }),
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toHaveProperty("ignored");
    expect(sqsSendMock).not.toHaveBeenCalled();
  });

  it("accepts the pinned repository when GITHUB_OWNER/GITHUB_REPO are set (case-insensitive)", async () => {
    process.env.GITHUB_OWNER = "exampleorg";
    process.env.GITHUB_REPO = "LAMBDA-MICROVM-RUNNERS";
    const handler = await loadHandler();
    const event = makeEvent({ payload: makePayload() });

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 202 });
    expect(sqsSendMock).toHaveBeenCalledTimes(1);
  });

  it("skips the repository check when GITHUB_OWNER/GITHUB_REPO are unset (backward compatible)", async () => {
    const handler = await loadHandler();
    const event = makeEvent({
      payload: makePayload({
        repository: {
          name: "some-other-repo",
          full_name: "SomeoneElse/some-other-repo",
          owner: { login: "SomeoneElse" },
        },
      }),
    });

    const result = await handler(event);

    expect(result).toMatchObject({ statusCode: 202 });
    expect(sqsSendMock).toHaveBeenCalledTimes(1);
  });

  it("caches the webhook secret across invocations and only fetches it once", async () => {
    const handler = await loadHandler();

    await handler(makeEvent({ payload: makePayload() }));
    await handler(makeEvent({ payload: makePayload(), deliveryId: "delivery-guid-2" }));

    expect(secretsSendMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed secret fetch, so the next invocation retries it", async () => {
    secretsSendMock.mockRejectedValueOnce(new Error("secrets manager unavailable"));
    const handler = await loadHandler();

    const first = await handler(makeEvent({ payload: makePayload() }));
    expect(first.statusCode).toBe(500);

    const second = await handler(
      makeEvent({ payload: makePayload(), deliveryId: "delivery-guid-3" }),
    );
    expect(second.statusCode).toBe(202);
    expect(secretsSendMock).toHaveBeenCalledTimes(2);
  });
});
