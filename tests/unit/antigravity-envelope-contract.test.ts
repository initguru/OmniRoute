import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAntigravityEnvelope,
  serializeAntigravityRequest,
  type AntigravityRequestContractContext,
} from "../../open-sse/executors/antigravity/requestContract.ts";
import {
  createAntigravityClientContext,
  type AntigravityClientContext,
} from "../../open-sse/config/antigravityClient.ts";
import { setCliCompatProviders } from "../../open-sse/config/cliFingerprints.ts";

function cliContext(): AntigravityClientContext {
  return createAntigravityClientContext("agy", { connectionId: "contract-test" });
}

function contractContext(
  overrides: Partial<AntigravityRequestContractContext> = {}
): AntigravityRequestContractContext {
  return {
    client: cliContext(),
    requestType: "agent",
    upstreamModel: "gemini-2.5-pro",
    allowBodyProjectOverride: false,
    ...overrides,
  };
}

function restoreCliCompat(): void {
  setCliCompatProviders([]);
  delete process.env.CLI_COMPAT_ANTIGRAVITY;
  delete process.env.CLI_COMPAT_ALL;
}

test.afterEach(restoreCliCompat);

test("canonical envelope excludes client fields and ignores inbound enabledCreditTypes", () => {
  const source: Record<string, unknown> = {
    project: "credential-project",
    request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    requestId: "client-request-id",
    userPromptId: "prompt-1",
    metadata: { user_id: "client-only" },
    service_tier: "auto",
    betas: ["client-only-beta"],
    arbitraryClientField: { should: "not reach upstream" },
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
  };

  const result = buildAntigravityEnvelope(source, contractContext());

  assert.deepEqual(Object.keys(result), [
    "project",
    "requestId",
    "request",
    "model",
    "userAgent",
    "requestType",
    "userPromptId",
  ]);
  assert.equal(result.project, "credential-project");
  assert.equal(result.model, "gemini-2.5-pro");
  assert.equal(result.userAgent, "antigravity");
  assert.equal(result.requestType, "agent");
  assert.equal(result.userPromptId, "prompt-1");
  assert.equal(result.enabledCreditTypes, undefined);
  assert.equal(result.metadata, undefined);
  assert.equal(result.service_tier, undefined);
  assert.equal(result.betas, undefined);
  assert.equal(result.arbitraryClientField, undefined);
  assert.equal(result.requestId === "client-request-id", false);
});

test("canonical envelope keeps image request type and only valid non-empty prompt IDs", () => {
  for (const userPromptId of [123, {}, [], null, "", "   "]) {
    const result = buildAntigravityEnvelope(
      {
        project: "project-1",
        userPromptId,
        request: { contents: [] },
      },
      contractContext({ requestType: "image_gen", upstreamModel: "gemini-3.1-flash-image" })
    );

    assert.equal(result.requestType, "image_gen");
    assert.equal(result.userPromptId, undefined);
  }

  const result = buildAntigravityEnvelope(
    {
      project: "project-1",
      userPromptId: "prompt-valid",
      request: { contents: [] },
    },
    contractContext({ requestType: "image_gen", upstreamModel: "gemini-3.1-flash-image" })
  );
  assert.equal(result.userPromptId, "prompt-valid");
});

test("tool metadata remains local and is absent from JSON serialization", () => {
  const toolNameMap = new Map([["safe_name", "original:name"]]);
  const result = buildAntigravityEnvelope(
    {
      project: "project-1",
      request: { contents: [] },
      _toolNameMap: toolNameMap,
    },
    contractContext()
  );

  assert.equal(result._toolNameMap, toolNameMap);
  assert.equal(Object.prototype.propertyIsEnumerable.call(result, "_toolNameMap"), false);
  assert.equal(JSON.stringify(result).includes("_toolNameMap"), false);
});

test("canonical envelope does not mutate the caller body or nested request", () => {
  const source: Record<string, unknown> = {
    project: "project-1",
    userPromptId: "prompt-1",
    request: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    metadata: { caller: true },
  };
  const before = structuredClone(source);

  const result = buildAntigravityEnvelope(source, contractContext());
  (result.request as Record<string, unknown>).contents = [];

  assert.deepEqual(source, before);
});

test("executor transform keeps caller body immutable while applying request guards", async () => {
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
  const source: Record<string, unknown> = {
    project: "project-1",
    request: {
      generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "assistant prefill" }] },
      ],
    },
  };
  const before = structuredClone(source);

  const result = await new AntigravityExecutor().transformRequest(
    "antigravity/gemini-3.1-pro",
    source,
    true,
    { projectId: "project-1" }
  );

  assert.ok(!(result instanceof Response));
  assert.deepEqual(source, before);
});

test("executor transforms once for two fallback upstream requests", async () => {
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  const originalTransformRequest = executor.transformRequest.bind(executor);
  const calls: string[] = [];
  let transformCalls = 0;
  executor.transformRequest = async (
    ...args: Parameters<AntigravityExecutor["transformRequest"]>
  ) => {
    transformCalls += 1;
    return originalTransformRequest(...args);
  };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  };

  try {
    const result = await executor.execute({
      model: "antigravity/gemini-2.5-flash",
      body: { request: { contents: [] } },
      stream: true,
      credentials: { accessToken: "token", projectId: "project-1" },
      log: { debug() {}, warn() {}, info() {} },
    });

    assert.equal(result.response.status, 404);
    assert.equal(calls.length, 2);
    assert.equal(transformCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("serializer scrubs native headers without applying generic CLI fingerprint when disabled", () => {
  const { headers, bodyString } = serializeAntigravityRequest(
    "antigravity",
    {
      Authorization: "Bearer token",
      "X-Forwarded-For": "127.0.0.1",
      "X-Stainless-Lang": "js",
      "User-Agent": "antigravity/ide/2.1.1 darwin/arm64",
      "x-custom-header": "kept",
    },
    {
      project: "project-1",
      requestId: "agent/1/abcdef12",
      request: { contents: [] },
      model: "gemini-2.5-pro",
      userAgent: "antigravity",
      requestType: "agent",
    },
    cliContext()
  );

  assert.equal(headers["X-Forwarded-For"], undefined);
  assert.equal(headers["X-Stainless-Lang"], undefined);
  assert.equal(headers["x-custom-header"], "kept");
  assert.equal(headers.Authorization, "Bearer token");
  assert.deepEqual(Object.keys(JSON.parse(bodyString)), [
    "project",
    "requestId",
    "request",
    "model",
    "userAgent",
    "requestType",
  ]);
});

test("serializer uses applyFingerprint output only when Antigravity CLI compatibility is enabled", () => {
  setCliCompatProviders(["antigravity"]);
  const inputHeaders = {
    Authorization: "Bearer token",
    "X-Forwarded-For": "127.0.0.1",
    "User-Agent": "antigravity/cli/1.1.1 (aidev_client)",
    "x-custom-header": "kept",
  };
  const inputBody = {
    requestType: "agent",
    model: "gemini-2.5-pro",
    requestId: "agent/1/abcdef12",
    request: { contents: [] },
    project: "project-1",
    userAgent: "antigravity",
  };

  const { headers, bodyString } = serializeAntigravityRequest(
    "antigravity",
    inputHeaders,
    inputBody,
    cliContext()
  );

  assert.notEqual(headers, inputHeaders);
  assert.equal(headers["X-Forwarded-For"], undefined);
  assert.equal(headers["x-custom-header"], "kept");
  assert.deepEqual(Object.keys(JSON.parse(bodyString)), [
    "project",
    "requestId",
    "request",
    "model",
    "userAgent",
    "requestType",
  ]);
  assert.deepEqual(inputBody, {
    requestType: "agent",
    model: "gemini-2.5-pro",
    requestId: "agent/1/abcdef12",
    request: { contents: [] },
    project: "project-1",
    userAgent: "antigravity",
  });
});
