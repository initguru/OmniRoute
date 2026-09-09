import { test } from "node:test";
import assert from "node:assert/strict";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { sendAntigravityRequest } from "../../open-sse/executors/antigravity/executeAttempt.ts";
import { setCliCompatProviders } from "../../open-sse/config/cliFingerprints.ts";
import { scrubProxyAndFingerprintHeaders } from "../../open-sse/services/antigravityHeaderScrub.ts";
import { antigravityIdeUserAgent } from "../../open-sse/services/antigravityHeaders.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";
import { clearAntigravityProjectCache } from "../../open-sse/services/antigravityProjectBootstrap.ts";
import { runWithCapture } from "../../open-sse/utils/providerRequestLogging.ts";

type AntigravityTransformResult = Exclude<
  Awaited<ReturnType<AntigravityExecutor["transformRequest"]>>,
  Response
>;

type ErrorPayload = {
  error: {
    code?: string;
    message: string;
  };
  retryAfterMs?: number;
};

type ChatCompletionPayload = {
  object?: string;
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

async function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test.afterEach(() => {
  clearAntigravityVersionCaches();
});

test("AntigravityExecutor exposes frozen retry state for token-refresh re-entry", async () => {
  const originalFetch = globalThis.fetch;
  seedAntigravityIdeVersionCache("2026.4.17");
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(await new Response(init?.body as BodyInit).text()));
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  };

  try {
    const executor = new AntigravityExecutor();
    const input = {
      model: "antigravity/gemini-2.5-flash",
      body: {
        request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      },
      stream: true,
      credentials: {
        accessToken: "retry-state-token",
        connectionId: "retry-state-connection",
        projectId: "project-1",
      },
      log: { debug() {}, warn() {}, info() {}, error() {} },
    };

    const first = await executor.execute(input);
    const retryState = (first as { providerRetryState?: unknown }).providerRetryState as {
      client?: Record<string, unknown>;
    };
    assert.ok(retryState, "initial execution must return provider retry state");

    const second = await executor.execute({
      ...input,
      credentials: { ...input.credentials, accessToken: "refreshed-token" },
      providerRetryState: retryState,
    });
    const secondRetryState = (
      second as { providerRetryState?: { client?: Record<string, unknown> } }
    ).providerRetryState;

    assert.deepEqual(retryState.client, {
      profile: "ide",
      contractId: "antigravity-wire-ide-synthetic-v1",
      observedVersion: null,
      versionState: "unverified",
      source: "provider-default",
    });
    assert.deepEqual(secondRetryState?.client, retryState.client);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      {
        requestId: requests[0].requestId,
        sessionId: (requests[0].request as Record<string, unknown>).sessionId,
      },
      {
        requestId: requests[1].requestId,
        sessionId: (requests[1].request as Record<string, unknown>).sessionId,
      }
    );
    assert.equal((retryState as { client?: { profile?: string } }).client?.profile, "ide");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor snapshots the effective credits body for refresh re-entry", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  let attempt = 0;
  globalThis.fetch = async (_url, init) => {
    requests.push(
      JSON.parse(await new Response(init?.body as BodyInit).text()) as Record<string, unknown>
    );
    attempt++;
    if (attempt === 1) {
      return Response.json({ error: { message: "quota exhausted" } }, { status: 429 });
    }
    if (attempt === 2) {
      return Response.json({ error: { message: "refresh required" } }, { status: 401 });
    }
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  };

  try {
    const executor = new AntigravityExecutor();
    const input = {
      model: "antigravity/gemini-2.5-flash",
      body: { request: { contents: [{ role: "user", parts: [{ text: "test" }] }] } },
      stream: true,
      credentials: {
        accessToken: "test-access-token",
        connectionId: "credits-retry-state-connection",
        projectId: "project-1",
      },
      log: { debug() {}, warn() {}, info() {}, error() {} },
    };

    const first = await withEnv("ANTIGRAVITY_CREDITS", "retry", () => executor.execute(input));
    const retryState = (first as { providerRetryState?: unknown }).providerRetryState as {
      semanticBody?: Record<string, unknown>;
    };
    assert.deepEqual(retryState.semanticBody?.enabledCreditTypes, ["GOOGLE_ONE_AI"]);

    await executor.execute({
      ...input,
      credentials: { ...input.credentials, accessToken: "refreshed-test-access-token" },
      providerRetryState: retryState,
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[0].enabledCreditTypes, undefined);
    assert.deepEqual(requests[1].enabledCreditTypes, ["GOOGLE_ONE_AI"]);
    assert.deepEqual(requests[2].enabledCreditTypes, ["GOOGLE_ONE_AI"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor retry state ignores caller mutations to semantic body", async () => {
  const originalFetch = globalThis.fetch;
  seedAntigravityIdeVersionCache("2026.4.17");
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(await new Response(init?.body as BodyInit).text()));
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\\n\\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  };

  try {
    const executor = new AntigravityExecutor();
    const body = {
      request: { contents: [{ role: "user", parts: [{ text: "original" }] }] },
    };
    const input = {
      model: "antigravity/gemini-2.5-flash",
      body,
      stream: true,
      credentials: {
        accessToken: "retry-state-mutation-token",
        connectionId: "retry-state-mutation-connection",
        projectId: "project-1",
      },
      log: { debug() {}, warn() {}, info() {}, error() {} },
    };

    const first = await executor.execute(input);
    const retryState = (first as { providerRetryState?: unknown }).providerRetryState as {
      semanticBody?: Record<string, unknown>;
    };
    assert.ok(retryState?.semanticBody, "initial execution must return semantic retry state");

    body.request.contents[0].parts[0].text = "caller mutation";
    try {
      const semanticRequest = retryState.semanticBody?.request as Record<string, unknown>;
      const semanticContents = semanticRequest.contents as Array<Record<string, unknown>>;
      const semanticParts = semanticContents[0].parts as Array<Record<string, unknown>>;
      semanticParts[0].text = "retry-state mutation";
    } catch {
      // An immutable snapshot is an accepted implementation of this contract.
    }

    await executor.execute({
      ...input,
      providerRetryState: retryState,
    });

    assert.equal(
      (
        (requests[1].request as Record<string, unknown>).contents as Array<Record<string, unknown>>
      )[0].parts &&
        (
          (
            (requests[1].request as Record<string, unknown>).contents as Array<
              Record<string, unknown>
            >
          )[0].parts as Array<Record<string, unknown>>
        )[0].text,
      "original"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor.buildUrl always targets the streaming endpoint", () => {
  const executor = new AntigravityExecutor();
  assert.match(
    executor.buildUrl("gemini-2.5-flash", true),
    /\/v1internal:streamGenerateContent\?alt=sse$/
  );
  assert.equal(
    executor.buildUrl("gemini-2.5-flash", false),
    executor.buildUrl("gemini-2.5-flash", true)
  );
});

test("AntigravityExecutor.buildHeaders includes native headers without OmniRoute internals", () => {
  const executor = new AntigravityExecutor();
  seedAntigravityIdeVersionCache("2.1.1");
  const headers = executor.buildHeaders({ accessToken: "ag-token" }, false);

  assert.equal(headers.Authorization, "Bearer ag-token");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(headers["User-Agent"], antigravityIdeUserAgent("2.1.1"));
  assert.equal(headers["X-OmniRoute-Source"], undefined);
});

test("Antigravity header scrub removes OmniRoute internal headers", () => {
  const headers = scrubProxyAndFingerprintHeaders({
    Authorization: "Bearer ag-token",
    "X-OmniRoute-Source": "omniroute",
    "X-OmniRoute-No-Cache": "true",
    "X-Forwarded-For": "127.0.0.1",
  });

  assert.equal(headers.Authorization, "Bearer ag-token");
  assert.equal(headers["X-OmniRoute-Source"], undefined);
  assert.equal(headers["X-OmniRoute-No-Cache"], undefined);
  assert.equal(headers["X-Forwarded-For"], undefined);
  assert.equal(headers["Accept-Encoding"], "gzip, deflate, br");
});

test("sendAntigravityRequest scrubs forbidden headers after serialization", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders = new Headers();
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response("ok", { status: 200 });
  };

  try {
    const result = await sendAntigravityRequest(
      "antigravity",
      "https://example.test/v1internal:streamGenerateContent?alt=sse",
      "gemini-2.5-flash",
      {
        Authorization: "Bearer token",
        "X-Forwarded-For": "127.0.0.1",
        "X-Stainless-Lang": "js",
        "Sec-Fetch-Site": "cross-site",
        Referer: "https://example.test",
        Priority: "u=1",
        "X-OmniRoute-Source": "test",
      },
      { request: { contents: [] } },
      { accessToken: "token", projectId: "project-1" },
      true,
      null,
      { debug() {}, warn() {}, info() {}, error() {} },
      0
    );

    assert.equal(result.response.status, 200);
    for (const name of [
      "x-forwarded-for",
      "x-stainless-lang",
      "sec-fetch-site",
      "referer",
      "priority",
      "x-omniroute-source",
    ]) {
      assert.equal(capturedHeaders.get(name), null, `${name} must not reach upstream`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor.execute scrubs forbidden extra headers before fetch", async () => {
  const executor = new AntigravityExecutor();
  seedAntigravityIdeVersionCache("2.1.1");
  const originalFetch = globalThis.fetch;
  let capturedHeaders = new Headers();
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  };

  try {
    const result = await executor.execute({
      model: "antigravity/gemini-2.5-flash",
      body: { request: { contents: [] } },
      stream: false,
      credentials: { accessToken: "token", projectId: "project-1" },
      upstreamExtraHeaders: {
        "X-Forwarded-For": "127.0.0.1",
        "X-Stainless-Lang": "js",
        "Sec-Fetch-Site": "cross-site",
        Referer: "https://example.test",
        Priority: "u=1",
        "X-OmniRoute-Source": "test",
      },
      log: { debug() {}, warn() {}, info() {} },
    });

    assert.equal(result.response.status, 200);
    for (const name of [
      "x-forwarded-for",
      "x-stainless-lang",
      "sec-fetch-site",
      "referer",
      "priority",
      "x-omniroute-source",
    ]) {
      assert.equal(capturedHeaders.get(name), null, `${name} must not reach upstream`);
    }
    assert.equal(capturedHeaders.get("user-agent"), antigravityIdeUserAgent("2.1.1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor.transformRequest normalizes model, project and contents", async () => {
  const executor = new AntigravityExecutor();
  const body = {
    request: {
      contents: [
        {
          role: "model",
          parts: [
            { thought: true, text: "skip me" },
            { thoughtSignature: "sig-only" },
            { text: "keep me" },
          ],
        },
        {
          role: "model",
          parts: [{ functionResponse: { name: "read_file", response: {} } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: "read_file" }] }],
    },
  };

  const result = await executor.transformRequest("antigravity/gemini-3.1-pro", body, true, {
    projectId: "project-1",
  });

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(result.project, "project-1");
  assert.equal(result.model, "gemini-3.1-pro");
  assert.deepEqual(Object.keys(result), [
    "project",
    "requestId",
    "request",
    "model",
    "userAgent",
    "requestType",
  ]);
  assert.equal(result.userAgent, "antigravity");
  assert.match(result.requestId, /^agent\/\d+\/[0-9a-f]{8}$/);
  assert.equal(result.enabledCreditTypes, undefined);
  assert.ok(result.request.sessionId);
  const request = result.request as { generationConfig?: { topK?: number; topP?: number } };
  const generationConfig = request.generationConfig || {};
  assert.equal(generationConfig.topK, 40);
  assert.equal(generationConfig.topP, 1.0);
  assert.deepEqual(result.request.toolConfig, {
    functionCallingConfig: { mode: "VALIDATED" },
  });
  assert.deepEqual(result.request.contents[0].parts, [{ text: "keep me" }]);
  assert.equal(result.request.contents[1].role, "user");
});

test("AntigravityExecutor.transformRequest strips thinking config for Cloud Code models that do not support reasoning", async () => {
  const executor = new AntigravityExecutor();
  const body = {
    reasoning_effort: "high",
    request: {
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 8192,
          includeThoughts: true,
        },
      },
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    },
  };

  const result = await executor.transformRequest("antigravity/claude-sonnet-4-6", body, true, {
    projectId: "project-1",
  });

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  const generationConfig = result.request.generationConfig as {
    thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
  };
  assert.equal(result.reasoning_effort, undefined);
  assert.equal(generationConfig.thinkingConfig, undefined);
});

test("AntigravityExecutor.transformRequest preserves thinking config for gemini-pro-agent", async () => {
  const executor = new AntigravityExecutor();
  const body = {
    request: {
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 8192,
          includeThoughts: true,
        },
      },
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    },
  };

  const result = await executor.transformRequest("antigravity/gemini-pro-agent", body, true, {
    projectId: "project-1",
  });

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  const generationConfig = result.request.generationConfig as {
    thinkingConfig: { thinkingBudget?: number; includeThoughts?: boolean };
  };
  assert.equal(generationConfig.thinkingConfig.thinkingBudget, 8192);
  assert.equal(generationConfig.thinkingConfig.includeThoughts, true);
});

test("AntigravityExecutor.transformRequest tolerates a missing body when projectId is present", async () => {
  const executor = new AntigravityExecutor();

  const result = await executor.transformRequest("antigravity/gemini-3.1-pro", null, true, {
    projectId: "project-1",
  });

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(result.project, "project-1");
  assert.equal(result.model, "gemini-3.1-pro");
  assert.ok(result.request.sessionId);
});

test("AntigravityExecutor.transformRequest returns a structured error response when projectId is missing", async () => {
  const executor = new AntigravityExecutor();
  const result = await executor.transformRequest(
    "gemini-2.5-flash",
    { request: { contents: [] } },
    true,
    {}
  );
  if (!(result instanceof Response)) throw new Error("Expected Response from transformRequest");
  const payload = (await result.json()) as ErrorPayload;

  assert.equal(result.status, 422);
  assert.equal(payload.error.code, "missing_project_id");
  assert.match(payload.error.message, /Missing Google projectId/);
});

// #2334/#2541: a freshly re-added Antigravity account can have an empty stored projectId
// even when its Google account already owns a Cloud Code project. transformRequest must
// auto-discover it via loadCodeAssist instead of hard-failing.
test("AntigravityExecutor.transformRequest auto-discovers a missing projectId via loadCodeAssist (#2334)", async () => {
  clearAntigravityProjectCache();
  seedAntigravityIdeVersionCache("2.1.1");
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  let loadCodeAssistCalled = false;

  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("loadCodeAssist")) {
      loadCodeAssistCalled = true;
      return new Response(JSON.stringify({ cloudaicompanionProject: "discovered-project-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await executor.transformRequest(
      "antigravity/gemini-3.1-pro",
      { request: { contents: [] } },
      true,
      { accessToken: "fresh-account-token-2334" }
    );
    if (result instanceof Response) {
      throw new Error(`Expected an envelope but got a ${result.status} Response`);
    }
    assert.equal(
      loadCodeAssistCalled,
      true,
      "loadCodeAssist should be called to recover the project"
    );
    assert.equal(result.project, "discovered-project-123");
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

// #8491: when loadCodeAssist also finds no project and Google marks the
// account BYOP (no automatic project creation for standard-tier accounts),
// the fast 422 GCP_PROJECT_REQUIRED must be returned so the dashboard can
// prompt the user to enter a GCP Project ID.
test("AntigravityExecutor.transformRequest fast-422s with GCP_PROJECT_REQUIRED when loadCodeAssist finds no project (#8491)", async () => {
  clearAntigravityProjectCache();
  seedAntigravityIdeVersionCache("2.1.1");
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

  try {
    const result = await executor.transformRequest(
      "antigravity/gemini-3.1-pro",
      { request: { contents: [] } },
      true,
      { accessToken: "no-project-token-2334" }
    );
    if (!(result instanceof Response)) throw new Error("Expected a 422 Response");
    assert.equal(result.status, 422);
    const payload = (await result.json()) as ErrorPayload;
    assert.equal(payload.error.code, "gcp_project_required");
    assert.match(payload.error.message, /GCP_PROJECT_REQUIRED/);
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

test("AntigravityExecutor.transformRequest prefers top-level credentials projectId over nested providerSpecificData", async () => {
  const executor = new AntigravityExecutor();
  const result = await executor.transformRequest(
    "antigravity/gemini-2.5-pro",
    {
      project: "body-project",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    },
    true,
    {
      projectId: "credential-project",
      providerSpecificData: { projectId: "nested-project" },
    }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(result.project, "credential-project");
});

test("AntigravityExecutor.transformRequest uses nested providerSpecificData projectId when top-level is absent", async () => {
  const executor = new AntigravityExecutor();
  const result = await executor.transformRequest(
    "antigravity/gemini-2.5-pro",
    {
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    },
    true,
    {
      providerSpecificData: { projectId: "nested-project" },
    }
  );

  if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
  assert.equal(result.project, "nested-project");
});

test("AntigravityExecutor.transformRequest treats whitespace-only project values as missing", async () => {
  const executor = new AntigravityExecutor();

  const nestedFallback = await executor.transformRequest(
    "antigravity/gemini-2.5-pro",
    {
      project: "   ",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    },
    true,
    {
      projectId: "   ",
      providerSpecificData: { projectId: " nested-project " },
    }
  );

  if (nestedFallback instanceof Response)
    throw new Error("Unexpected Response from transformRequest");
  assert.equal(nestedFallback.project, "nested-project");

  const bodyFallback = await executor.transformRequest(
    "antigravity/gemini-2.5-pro",
    {
      project: " body-project ",
      request: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    },
    true,
    {
      projectId: "   ",
      providerSpecificData: { projectId: "   " },
    }
  );

  if (bodyFallback instanceof Response)
    throw new Error("Unexpected Response from transformRequest");
  assert.equal(bodyFallback.project, "body-project");
});

test("AntigravityExecutor.transformRequest allows body project overrides when the env flag is enabled", async () => {
  const executor = new AntigravityExecutor();

  await withEnv("OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE", "1", async () => {
    const result = await executor.transformRequest(
      "antigravity/gemini-2.5-pro",
      {
        project: "body-project",
        request: {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          sessionId: "session-fixed",
        },
      },
      true,
      { projectId: "credential-project" }
    );

    if (result instanceof Response) throw new Error("Unexpected Response from transformRequest");
    assert.equal(result.project, "body-project");
    assert.equal(result.request.sessionId, "session-fixed");
    assert.equal(result.model, "gemini-2.5-pro");
  });
});

test("AntigravityExecutor parses retry timing from headers and error strings", () => {
  const executor = new AntigravityExecutor();
  const headers = new Headers({
    "retry-after": "120",
    "x-ratelimit-reset-after": "30",
  });

  assert.equal(executor.parseRetryHeaders(headers), 120_000);
  assert.equal(
    executor.parseRetryFromErrorMessage("Your quota will reset after 2h7m23s"),
    7_643_000
  );
});

test("AntigravityExecutor.parseRetryHeaders falls back to reset-after and reset timestamps", () => {
  const executor = new AntigravityExecutor();
  const futureSeconds = Math.floor(Date.now() / 1000) + 90;

  assert.equal(
    executor.parseRetryHeaders(new Headers({ "x-ratelimit-reset-after": "45" })),
    45_000
  );
  assert.ok(
    executor.parseRetryHeaders(new Headers({ "x-ratelimit-reset": String(futureSeconds) })) >=
      89_000
  );
});

test("AntigravityExecutor.collectStreamToResponse turns SSE Gemini chunks into a chat completion", async () => {
  const executor = new AntigravityExecutor();
  const response = new Response(
    [
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello "}]},"finishReason":"STOP"}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}}\n\n',
    ].join(""),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );

  const result = await executor.collectStreamToResponse(
    response,
    "gemini-2.5-flash",
    "https://example.com",
    { Authorization: "Bearer ag-token" },
    { request: {} }
  );
  const payload = (await result.response.json()) as ChatCompletionPayload;

  assert.equal(result.response.status, 200);
  assert.equal(payload.object, "chat.completion");
  assert.equal(payload.choices[0].message.content, "Hello world");
  assert.equal(payload.choices[0].finish_reason, "stop");
  assert.deepEqual(payload.usage, {
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
  });
});

test("AntigravityExecutor.collectStreamToResponse converts textual tool call SSE to structured tool_calls", async () => {
  const executor = new AntigravityExecutor();
  const response = new Response(
    [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '[Tool call: search_files]\nArguments: {"file_glob":"*gemini*","output_mode":"files_only","path":"/opt/O\\u200dmniRoute","target":"files"}',
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 7,
            candidatesTokenCount: 4,
            totalTokenCount: 11,
          },
        },
      })}\n\n`,
    ].join(""),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );

  const result = await executor.collectStreamToResponse(
    response,
    "gemini-3.7-flash-low",
    "https://example.com",
    { Authorization: "Bearer ag-token" },
    { request: {} }
  );
  const payload = await result.response.json();
  const choice = payload.choices[0];

  assert.equal(choice.message.content, null);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.tool_calls.length, 1);
  assert.equal(choice.message.tool_calls[0].function.name, "search_files");
  assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), {
    file_glob: "*gemini*",
    output_mode: "files_only",
    path: "/opt/OmniRoute",
    target: "files",
  });
});

test("AntigravityExecutor.collectStreamToResponse parses fragmented SSE lines incrementally", async () => {
  const executor = new AntigravityExecutor();
  const encoder = new TextEncoder();
  const streamText = [
    `data: ${JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: "Frag" }] } }],
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: { parts: [{ text: "mented" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 4,
          totalTokenCount: 13,
        },
      },
    })}\n\n`,
  ].join("");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of [
          streamText.slice(0, 6),
          streamText.slice(6, 31),
          streamText.slice(31, 79),
          streamText.slice(79, 143),
          streamText.slice(143),
        ]) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );

  const result = await executor.collectStreamToResponse(
    response,
    "gemini-2.5-flash",
    "https://example.com",
    { Authorization: "Bearer ag-token" },
    { request: {} }
  );
  const payload = (await result.response.json()) as ChatCompletionPayload;

  assert.equal(payload.choices[0].message.content, "Fragmented");
  assert.equal(payload.choices[0].finish_reason, "stop");
  assert.deepEqual(payload.usage, {
    prompt_tokens: 9,
    completion_tokens: 4,
    total_tokens: 13,
  });
});

test("AntigravityExecutor.refreshCredentials refreshes Google OAuth tokens", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /oauth2\.googleapis\.com\/token$/);
    return new Response(
      JSON.stringify({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const result = await executor.refreshCredentials(
      { refreshToken: "refresh", projectId: "project-1" },
      null
    );
    assert.deepEqual(result, {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresIn: 3600,
      projectId: "project-1",
      providerSpecificData: {
        clientProfile: "ide",
        clientContractId: "antigravity-wire-ide-synthetic-v1",
        clientObservedVersion: null,
        clientVersionState: "unverified",
        clientContextSource: "provider-default",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor.refreshCredentials discovers projectId when stored value is empty", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  clearAntigravityProjectCache();

  let fetchCalls: string[] = [];
  globalThis.fetch = async (url, _init) => {
    const urlStr = String(url);
    fetchCalls.push(urlStr);
    // Token refresh endpoint
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // loadCodeAssist endpoint - returns a projectId
    if (urlStr.includes("loadCodeAssist")) {
      return new Response(JSON.stringify({ cloudaicompanionProject: "discovered-project" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await executor.refreshCredentials(
      { refreshToken: "refresh", projectId: "", connectionId: "conn-1" },
      null
    );
    assert.equal(result?.projectId, "discovered-project");
    assert.equal(result?.accessToken, "new-token");
    assert.equal(result?.refreshToken, "new-refresh");
    assert.equal(result?.expiresIn, 3600);
    assert.ok(
      fetchCalls.some((u) => u.includes("oauth2.googleapis.com/token")),
      "should call token endpoint"
    );
    assert.ok(
      fetchCalls.some((u) => u.includes("loadCodeAssist")),
      "should call loadCodeAssist"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

test("AntigravityExecutor.refreshCredentials skips discovery when projectId already set", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  clearAntigravityProjectCache();

  let fetchCalls: string[] = [];
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    fetchCalls.push(urlStr);
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await executor.refreshCredentials(
      { refreshToken: "refresh", projectId: "existing-project" },
      null
    );
    assert.equal(result?.projectId, "existing-project");
    assert.ok(
      !fetchCalls.some((u) => u.includes("loadCodeAssist")),
      "should NOT call loadCodeAssist"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

test("AntigravityExecutor.refreshCredentials handles discovery failure gracefully", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  clearAntigravityProjectCache();

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // loadCodeAssist fails
    if (urlStr.includes("loadCodeAssist")) {
      return new Response("server error", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await executor.refreshCredentials(
      { refreshToken: "refresh", projectId: "", connectionId: "conn-1" },
      null
    );
    // Discovery failed, projectId stays empty but refresh still succeeds
    assert.equal(result?.projectId, "");
    assert.equal(result?.accessToken, "new-token");
    assert.equal(result?.refreshToken, "new-refresh");
    assert.equal(result?.expiresIn, 3600);
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

test("AntigravityExecutor.refreshCredentials skips discovery when access_token is not a string", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  clearAntigravityProjectCache();

  let fetchCalls: string[] = [];
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    fetchCalls.push(urlStr);
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      // access_token missing from response
      return new Response(JSON.stringify({ refresh_token: "new-refresh", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const result = await executor.refreshCredentials(
      { refreshToken: "refresh", projectId: "", connectionId: "conn-1" },
      null
    );
    assert.equal(result?.projectId, "");
    assert.equal(result?.accessToken, undefined);
    assert.ok(
      !fetchCalls.some((u) => u.includes("loadCodeAssist")),
      "should NOT call loadCodeAssist"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

// The non-streaming passthrough drain test ("auto-retries short 429 responses and
// collects SSE for non-stream clients") lives in
// tests/unit/antigravity-streaming-passthrough.test.ts with the other passthrough tests.

test("AntigravityExecutor.execute embeds retryAfterMs when the upstream asks for a long wait", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  seedAntigravityIdeVersionCache("2.1.1");

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Your quota will reset after 2h",
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }
    );

  try {
    const result = await executor.execute({
      model: "antigravity/gemini-2.5-flash",
      body: { request: { contents: [] } },
      stream: true,
      credentials: { accessToken: "token", projectId: "project-1" },
      log: { debug() {}, warn() {} },
    });
    const payload = (await result.response.json()) as ErrorPayload;

    assert.equal(result.response.status, 429);
    assert.equal(payload.retryAfterMs, 7_200_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor.execute bounds a persistent short-retry 429 instead of looping forever", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const calls: string[] = [];
  seedAntigravityIdeVersionCache("2.1.1");

  // "rate limited" with no parseable retry hint classifies as rate_limited →
  // decide429 returns short_cooldown_switch_auth (60s default). Since #9351 the
  // switchAuth signal is propagated to the retry guard, which declines the
  // same-URL sleep branch entirely: one attempt per base URL, then the 429 is
  // returned so the account-fallback layer can switch accounts immediately
  // instead of sleeping 60s × MAX_AUTO_RETRIES against a rate-limited account.
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  };
  globalThis.setTimeout = ((callback) => {
    (callback as () => void)();
    return 0;
  }) as typeof setTimeout;

  try {
    const result = await executor.execute({
      model: "antigravity/gemini-2.5-flash",
      body: { request: { contents: [] } },
      stream: true,
      credentials: { accessToken: "token", projectId: "project-1" },
      log: { debug() {}, warn() {} },
    });

    // Returns the 429 rather than hanging.
    assert.equal(result.response.status, 429);

    // Bounded: switchAuth declines same-URL retries → 2 live runtime endpoints
    // × 1 attempt each = 2 attempts total (#9351).
    assert.equal(calls.length, 2);

    // Tried every distinct live runtime base URL before giving up.
    const distinctHosts = new Set(calls.map((u) => new URL(u).host));
    assert.equal(distinctHosts.size, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("AntigravityExecutor.execute aborts during project bootstrap without starting runtime fetch", async () => {
  clearAntigravityProjectCache();
  seedAntigravityIdeVersionCache("2.1.1");
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: string[] = [];

  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.match(String(url), /:loadCodeAssist$/);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };

  try {
    const pending = executor.execute({
      model: "antigravity/gemini-2.5-flash",
      body: { request: { contents: [] } },
      stream: true,
      credentials: { accessToken: "bootstrap-abort-token" },
      signal: controller.signal,
      log: { debug() {}, warn() {} },
    });
    while (calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new DOMException("caller disconnected", "AbortError"));

    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(calls.length, 1);
    assert.equal(
      calls.some((url) => url.includes("streamGenerateContent")),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearAntigravityProjectCache();
  }
});

test("AntigravityExecutor.execute tags pre-response stalls with a fallbackable timeout code", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  seedAntigravityIdeVersionCache("2.1.1");

  globalThis.fetch = async (_url, init) => {
    await new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable");
  };
  globalThis.setTimeout = ((callback) => {
    (callback as () => void)();
    return 0;
  }) as typeof setTimeout;

  try {
    await assert.rejects(
      () =>
        executor.execute({
          model: "antigravity/gemini-2.5-flash",
          body: { request: { contents: [] } },
          stream: true,
          credentials: { accessToken: "token", projectId: "project-1" },
          log: { debug() {}, warn() {}, error() {} },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "ANTIGRAVITY_PRE_RESPONSE_TIMEOUT");
        assert.equal((error as { name?: string }).name, "TimeoutError");
        assert.match((error as Error).message, /did not return response headers/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("AntigravityExecutor.execute applies CLI fingerprint when enabled", async () => {
  const executor = new AntigravityExecutor();
  const originalFetch = globalThis.fetch;
  let fetchStarted = false;
  let fetchBody: Record<string, unknown> | null = null;
  let prepared: unknown = null;
  let preparedBeforeFetch = false;
  seedAntigravityIdeVersionCache("2.1.1");
  setCliCompatProviders(["antigravity"]);

  globalThis.fetch = async (_url, init) => {
    fetchStarted = true;
    const headers = init?.headers as Record<string, string>;
    const parsedBody = JSON.parse(String(init?.body));
    fetchBody = parsedBody;

    assert.equal(headers["User-Agent"], antigravityIdeUserAgent("2.1.1"));
    assert.equal(headers["x-client-name"], undefined);
    assert.equal(headers["x-client-version"], undefined);
    assert.equal(headers["x-goog-user-project"], "project-1");
    assert.deepEqual(Object.keys(parsedBody), [
      "project",
      "requestId",
      "request",
      "model",
      "userAgent",
      "requestType",
      "enabledCreditTypes",
    ]);
    assert.deepEqual(parsedBody.enabledCreditTypes, ["GOOGLE_ONE_AI"]);

    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  };

  try {
    const requestCapture = {
      capture(request) {
        preparedBeforeFetch = !fetchStarted;
        prepared = request.body;
      },
      body(fallback) {
        return prepared ?? fallback;
      },
      latest() {
        return null;
      },
    };
    const result = await withEnv("ANTIGRAVITY_CREDITS", "always", () =>
      runWithCapture(requestCapture, () =>
        executor.execute({
          model: "antigravity/gemini-2.5-flash",
          body: { request: { contents: [] } },
          stream: false,
          credentials: { accessToken: "token", projectId: "project-1" },
          log: { debug() {}, warn() {}, info() {} },
        })
      )
    );

    assert.equal(result.response.status, 200);
    assert.equal(preparedBeforeFetch, true);
    assert.deepEqual(prepared, fetchBody);
  } finally {
    setCliCompatProviders([]);
    globalThis.fetch = originalFetch;
  }
});

test("AntigravityExecutor.transformRequest maps Claude models through Gemini contents schema", async () => {
  const executor = new AntigravityExecutor();
  const body = {
    project: "project-1",
    model: "claude-sonnet-4-6",
    userAgent: "antigravity",
    requestId: "agent-123",
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: { role: "system", parts: [{ text: "System prompt" }] },
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 16384,
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Legacy Anthropic field" }] }],
      system: [{ type: "text", text: "Legacy system field" }],
      max_tokens: 16384,
      stream: true,
      temperature: 1,
    },
  };

  const result = (await executor.transformRequest("antigravity/claude-sonnet-4-6", body, true, {
    projectId: "project-1",
  })) as AntigravityTransformResult;

  assert.equal(result.project, "project-1");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.requestType, "agent");
  assert.ok(result.request.sessionId);
  assert.equal(result.enabledCreditTypes, undefined);
  assert.deepEqual(result.request.contents, [{ role: "user", parts: [{ text: "Hello" }] }]);
  assert.deepEqual(result.request.systemInstruction, {
    role: "system",
    parts: [{ text: "System prompt" }],
  });
  assert.deepEqual(result.request.generationConfig, {
    temperature: 1,
    maxOutputTokens: 16384,
    topK: 40,
    topP: 1.0,
  });
  assert.equal(result.request.messages, undefined);
  assert.equal(result.request.system, undefined);
  assert.equal(result.request.max_tokens, undefined);
  assert.equal(result.request.stream, undefined);
  assert.equal(result.request.temperature, undefined);
  assert.equal(result.request.toolConfig, undefined);
});
