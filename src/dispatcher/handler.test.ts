import { createVerify, generateKeyPairSync } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, SQSEvent } from "aws-lambda";

const mocks = vi.hoisted(() => ({
  dynamoSend: vi.fn(),
  secretsSend: vi.fn(),
  microvmsSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: mocks.dynamoSend })),
  PutItemCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  DeleteItemCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: mocks.secretsSend })),
  GetSecretValueCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

vi.mock("@aws-sdk/client-lambda-microvms", () => ({
  LambdaMicrovmsClient: vi.fn().mockImplementation(() => ({ send: mocks.microvmsSend })),
  RunMicrovmCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const fetchMock = vi.fn();

const BASE_ENV = {
  AWS_REGION: "us-east-1",
  GITHUB_APP_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:sbx/gha-microvm-runner/github-app",
  GITHUB_OWNER: "ExampleOrg",
  GITHUB_REPO: "lambda-microvm-runners",
  MICROVM_IMAGE_IDENTIFIER: "image-123",
  MICROVM_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/sbx-microvm-exec",
  DEDUPE_TABLE_NAME: "sbx-use1-gha-microvm-dedupe",
  RUNNER_GROUP_ID: "1",
  MICROVM_MAX_DURATION_SECONDS: "3600",
  MICROVM_MAX_IDLE_SECONDS: "900",
  MICROVM_SUSPENDED_SECONDS: "10",
};

let rsaKeyPair: { publicKey: string; privateKey: string };

beforeAll(() => {
  rsaKeyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
});

beforeEach(() => {
  vi.resetModules();
  mocks.dynamoSend.mockReset();
  mocks.secretsSend.mockReset();
  mocks.microvmsSend.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(process.env, BASE_ENV);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function importHandler() {
  const mod = await import("./handler.js");
  return mod.handler as unknown as (event: SQSEvent, context: Context) => Promise<void>;
}

// plenty of headroom by default so the self-imposed deadline (remaining time minus a
// 5s buffer) never fires during normal-path tests
function makeContext(remainingMs = 60000): Context {
  return {
    getRemainingTimeInMillis: () => remainingMs,
  } as unknown as Context;
}

function makeEvent(body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: "test-message-id",
        receiptHandle: "test-receipt-handle",
        body,
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "0",
          SenderId: "test-sender",
          ApproximateFirstReceiveTimestamp: "0",
        },
        messageAttributes: {},
        md5OfBody: "test-md5",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:sbx-use1-gha-microvm-webhookqueue",
        awsRegion: "us-east-1",
      },
    ],
  };
}

function validMessageBody(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    deliveryId: "delivery-1",
    jobId: 42,
    runId: 99,
    labels: ["lambda-microvms"],
    ...overrides,
  });
}

function okJsonResponse(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body };
}

function secretResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    SecretString: JSON.stringify({
      appClientId: "app-client-id-123",
      installationId: 555,
      privateKey: rsaKeyPair.privateKey,
      ...overrides,
    }),
  };
}

describe("dispatcher handler", () => {
  it("short-circuits on a duplicate delivery without calling GitHub or RunMicrovm", async () => {
    mocks.dynamoSend.mockRejectedValueOnce(
      Object.assign(new Error("conditional check failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    const handler = await importHandler();
    await expect(
      handler(makeEvent(validMessageBody({ deliveryId: "dup-1" })), makeContext()),
    ).resolves.toBeUndefined();

    expect(mocks.dynamoSend).toHaveBeenCalledTimes(1);
    expect(mocks.secretsSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.microvmsSend).not.toHaveBeenCalled();
  });

  it("mints a well-formed JWT, sends the correct jitconfig request, and dispatches a gzipped RunMicrovm payload", async () => {
    mocks.dynamoSend.mockResolvedValueOnce({});
    mocks.secretsSend.mockResolvedValueOnce(secretResponse());
    fetchMock
      .mockResolvedValueOnce(okJsonResponse({ token: "installation-token-abc" }))
      .mockResolvedValueOnce(okJsonResponse({ encoded_jit_config: "encoded-jit-config-xyz" }, 201));
    mocks.microvmsSend.mockResolvedValueOnce({});

    const handler = await importHandler();
    await handler(makeEvent(validMessageBody()), makeContext());

    // idempotency claim happened first, keyed on deliveryId
    const putCall = mocks.dynamoSend.mock.calls[0][0] as { input: { TableName: string; Item: { pk: { S: string } } } };
    expect(putCall.input.TableName).toBe(BASE_ENV.DEDUPE_TABLE_NAME);
    expect(putCall.input.Item.pk.S).toBe("delivery#delivery-1");

    // --- installation token request / JWT shape ---
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://api.github.com/app/installations/555/access_tokens");
    expect(tokenInit.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });

    const authHeader = (tokenInit.headers as Record<string, string>).Authorization;
    expect(authHeader).toMatch(/^Bearer /);
    const jwt = authHeader.replace("Bearer ", "");
    const [headerPart, payloadPart, signaturePart] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("app-client-id-123");
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    expect(verifier.verify(rsaKeyPair.publicKey, Buffer.from(signaturePart, "base64url"))).toBe(true);

    // --- generate-jitconfig request body ---
    const [jitUrl, jitInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(jitUrl).toBe(
      "https://api.github.com/repos/ExampleOrg/lambda-microvm-runners/actions/runners/generate-jitconfig",
    );
    expect((jitInit.headers as Record<string, string>).Authorization).toBe("Bearer installation-token-abc");
    const jitBody = JSON.parse(jitInit.body as string);
    expect(jitBody.name).toMatch(/^gha-mvm-42-[0-9a-f]{6}$/);
    expect(jitBody.runner_group_id).toBe(1);
    expect(jitBody.labels).toEqual(["lambda-microvms"]);

    // --- RunMicrovm gets the gzipped, base64-encoded jit config ---
    expect(mocks.microvmsSend).toHaveBeenCalledTimes(1);
    const runCall = mocks.microvmsSend.mock.calls[0][0] as {
      input: { imageIdentifier: string; executionRoleArn: string; runHookPayload: string };
    };
    expect(runCall.input.imageIdentifier).toBe(BASE_ENV.MICROVM_IMAGE_IDENTIFIER);
    expect(runCall.input.executionRoleArn).toBe(BASE_ENV.MICROVM_EXECUTION_ROLE_ARN);
    const decompressed = gunzipSync(Buffer.from(runCall.input.runHookPayload, "base64")).toString("utf8");
    expect(decompressed).toBe("encoded-jit-config-xyz");
  });

  it(
    "retries RunMicrovm up to 3 times, then deletes the dedupe row and rethrows on final failure",
    async () => {
      mocks.dynamoSend.mockResolvedValueOnce({}); // claim succeeds
      mocks.dynamoSend.mockResolvedValueOnce({}); // delete succeeds
      mocks.secretsSend.mockResolvedValueOnce(secretResponse());
      fetchMock
        .mockResolvedValueOnce(okJsonResponse({ token: "installation-token-abc" }))
        .mockResolvedValueOnce(okJsonResponse({ encoded_jit_config: "encoded-jit-config-xyz" }, 201));
      mocks.microvmsSend
        .mockRejectedValueOnce(new Error("microvm api unavailable"))
        .mockRejectedValueOnce(new Error("microvm api unavailable"))
        .mockRejectedValueOnce(new Error("microvm api unavailable"));

      const handler = await importHandler();

      // real timers on purpose: the two 5s retry waits run out in real time here
      // rather than fighting fake-timer/rejected-promise interleaving edge cases
      await expect(
        handler(makeEvent(validMessageBody({ deliveryId: "fail-1" })), makeContext()),
      ).rejects.toThrow("microvm api unavailable");

      expect(mocks.microvmsSend).toHaveBeenCalledTimes(3);
      expect(mocks.dynamoSend).toHaveBeenCalledTimes(2);
      const deleteCall = mocks.dynamoSend.mock.calls[1][0] as { input: { Key: { pk: { S: string } } } };
      expect(deleteCall.input.Key.pk.S).toBe("delivery#fail-1");
    },
    15000,
  );

  it("throws on a malformed message body without ever claiming the dedupe row", async () => {
    const handler = await importHandler();
    await expect(handler(makeEvent("{ not valid json"), makeContext())).rejects.toThrow();
    expect(mocks.dynamoSend).not.toHaveBeenCalled();
  });

  it("gives up and deletes the dedupe row if the self-imposed deadline elapses before dispatch finishes", async () => {
    mocks.dynamoSend.mockResolvedValueOnce({}); // claim succeeds
    mocks.dynamoSend.mockResolvedValueOnce({}); // delete succeeds
    mocks.secretsSend.mockResolvedValueOnce(secretResponse());
    // never resolves: simulates work that's still in flight when the Lambda's
    // remaining time runs out
    fetchMock.mockReturnValueOnce(new Promise(() => {}));

    const handler = await importHandler();

    // remainingMs (4000) minus the 5s safety buffer clamps to 0, so the deadline
    // fires almost immediately, well before the never-resolving fetch call
    await expect(
      handler(makeEvent(validMessageBody({ deliveryId: "timeout-1" })), makeContext(4000)),
    ).rejects.toThrow(/deadline/i);

    expect(mocks.microvmsSend).not.toHaveBeenCalled();
    expect(mocks.dynamoSend).toHaveBeenCalledTimes(2);
    const deleteCall = mocks.dynamoSend.mock.calls[1][0] as { input: { Key: { pk: { S: string } } } };
    expect(deleteCall.input.Key.pk.S).toBe("delivery#timeout-1");
  });
});
