import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { handleImageGeneration } from "../../open-sse/handlers/imageGeneration.ts";
import { ensureAntigravityProjectAssigned } from "../../open-sse/services/antigravityProjectBootstrap.ts";
import { getAntigravityUsage } from "../../open-sse/services/usage/antigravity.ts";
import { createAntigravityOAuthProvider } from "../../src/lib/oauth/providers/antigravity.ts";
import { ANTIGRAVITY_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import { AntigravityHandler } from "../../src/mitm/handlers/antigravity.ts";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";
import { getImageProvider } from "../../open-sse/config/imageRegistry.ts";
import { PROVIDERS } from "../../open-sse/config/constants.ts";
import {
  getAntigravityClientContract,
  type AntigravityClientContext,
} from "../../open-sse/config/antigravityClient.ts";
import { classifyAntigravityCompatibilityError } from "../../open-sse/services/errorClassifier.ts";
import {
  compareObservedRequests,
  type AntigravityObservedRequest,
  type AntigravityReferenceManifest,
} from "../helpers/antigravityWireContract.ts";
import {
  getCliCompatProviders,
  setCliCompatProviders,
} from "../../open-sse/config/cliFingerprints.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = path.join(ROOT, "tests/fixtures/antigravity-wire");
const STREAM_BODY = "data: synthetic-receiver\\n\\n";
const EXPECTED_CLI_USER_AGENT =
  "antigravity/cli/1.1.5 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)";
const canonicalSemanticRequest = {
  project: "synthetic-project",
  request: {
    contents: [{ role: "user", parts: [{ text: "compatibility probe" }] }],
    generationConfig: { maxOutputTokens: 16 },
  },
};

type CapturedRequest = {
  method: string;
  url: string;
  httpVersion: string;
  headers: Array<[string, string]>;
  bodyUtf8: string;
};

async function startLocalReceiver(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "https://example.invalid/not-allowed" });
        response.end();
        return;
      }
      if (request.url === "/inject-header") {
        response.setHeader("x-new-header", "unexpected");
      }
      const rawHeaders = request.rawHeaders;
      const headers: Array<[string, string]> = [];
      for (let index = 0; index < rawHeaders.length; index += 2) {
        headers.push([rawHeaders[index], rawHeaders[index + 1]]);
      }
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        httpVersion: request.httpVersion,
        headers,
        bodyUtf8: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      response.end(STREAM_BODY);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("synthetic receiver did not expose a TCP address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function readManifest(profile: "cli" | "ide"): AntigravityReferenceManifest {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${profile}-manifest.json`), "utf8")
  ) as AntigravityReferenceManifest;
}

function persistedContext(profile: "cli" | "ide", version: string): AntigravityClientContext {
  return {
    profile,
    contractId: getAntigravityClientContract(profile).contractId,
    observedVersion: version,
    versionState: "unverified",
    source: "credential",
  };
}

function credentialsFor(profile: "cli" | "ide", version: string) {
  const context = persistedContext(profile, version);
  return {
    accessToken: "fixturetoken",
    projectId: "synthetic-project",
    connectionId: `synthetic-${profile}`,
    providerSpecificData: {
      clientProfile: profile,
      clientContractId: context.contractId,
      clientObservedVersion: context.observedVersion,
      clientVersionState: context.versionState,
      clientContextSource: context.source,
    },
  };
}

function headerValues(request: CapturedRequest): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    const entries = values.get(lower) ?? [];
    entries.push(value);
    values.set(lower, entries);
  }
  return values;
}

function comparatorProjection(request: CapturedRequest): AntigravityObservedRequest {
  const headers = request.headers.map(
    ([name, value]) => [name.toLowerCase(), value] as [string, string]
  );
  return {
    method: request.method,
    url: request.url,
    httpVersion: request.httpVersion,
    headers,
    bodyUtf8: request.bodyUtf8,
  };
}

function expectedProjection(
  baseUrl: string,
  bodyUtf8: string,
  profile: "cli" | "ide"
): AntigravityObservedRequest {
  return {
    method: "POST",
    url: `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
    httpVersion: "1.1",
    headers: [
      ["host", new URL(baseUrl).host],
      ["connection", "close"],
      ["content-type", "application/json"],
      ["accept", "text/event-stream"],
      [
        "user-agent",
        profile === "cli" ? EXPECTED_CLI_USER_AGENT : "antigravity/ide/2.1.1 darwin/arm64",
      ],
      ["x-goog-user-project", "synthetic-project"],
      ["accept-encoding", "gzip, deflate, br"],
      ["authorization", "Bearer fixturetoken"],
      ["accept-language", "*"],
      ["sec-fetch-mode", "cors"],
      ["transfer-encoding", "chunked"],
    ],
    bodyUtf8,
  };
}

function expectedBody(): string {
  return JSON.stringify({
    project: "synthetic-project",
    requestId: "agent/0/abcdef12",
    request: {
      contents: [{ role: "user", parts: [{ text: "compatibility probe" }] }],
      generationConfig: { maxOutputTokens: 16, topK: 40, topP: 1 },
      sessionId: "-123",
    },
    model: "gemini-2.5-flash",
    userAgent: "antigravity",
    requestType: "agent",
  });
}

function assertProfileHeaders(request: CapturedRequest, profile: "cli" | "ide"): void {
  const values = headerValues(request);
  assert.deepEqual(values.get("content-type"), ["application/json"]);
  assert.deepEqual(values.get("accept"), ["text/event-stream"]);
  assert.deepEqual(values.get("accept-encoding"), ["gzip, deflate, br"]);
  assert.deepEqual(values.get("x-goog-user-project"), ["synthetic-project"]);
  assert.deepEqual(values.get("authorization"), ["Bearer fixturetoken"]);
  const userAgent = values.get("user-agent")?.[0] ?? "";
  if (profile === "cli") {
    assert.equal(userAgent, EXPECTED_CLI_USER_AGENT);
  } else {
    assert.equal(userAgent, "antigravity/ide/2.1.1 darwin/arm64");
  }

  for (const forbidden of [
    "x-client-name",
    "x-client-version",
    "x-machine-id",
    "x-vscode-sessionid",
    "x-goog-api-client",
    "client-metadata",
    "x-forwarded-for",
    "x-stainless-lang",
    "sec-fetch-site",
    "referer",
    "priority",
    "x-omniroute-source",
  ]) {
    assert.equal(values.has(forbidden), false, `${forbidden} must not reach synthetic upstream`);
  }
}

async function startProductionReceiver(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const requestUrl = request.url ?? "/";
      const pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
      const headers: Array<[string, string]> = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headers.push([request.rawHeaders[index], request.rawHeaders[index + 1]]);
      }
      const bodyUtf8 = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: requestUrl,
        httpVersion: request.httpVersion,
        headers,
        bodyUtf8,
      });

      let body = "{}";
      let contentType = "application/json";
      if (pathname === "/oauth/token") {
        body = JSON.stringify({
          access_token: "oauth-access-token",
          refresh_token: "oauth-refresh-token",
          expires_in: 3600,
        });
      } else if (pathname === "/oauth/userinfo") {
        body = JSON.stringify({ email: "fixture@example.com" });
      } else if (pathname === "/v1internal:loadCodeAssist") {
        body = JSON.stringify({ cloudaicompanionProject: "synthetic-project" });
      } else if (pathname === "/v1internal:onboardUser") {
        body = JSON.stringify({ done: true });
      } else if (
        pathname === "/v1internal:fetchAvailableModels" ||
        pathname === "/v1internal:retrieveUserQuota"
      ) {
        body = JSON.stringify({ models: {}, buckets: [] });
      } else if (pathname === "/v1internal:retrieveUserQuotaSummary") {
        body = JSON.stringify({ groups: [] });
      } else if (pathname === "/v1internal:streamGenerateContent") {
        const parsedBody = JSON.parse(bodyUtf8) as { requestType?: string };
        if (parsedBody.requestType === "image_gen") {
          body = JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }],
                  },
                },
              ],
            },
          });
        } else {
          body =
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"synthetic response"}]},"finishReason":"STOP"}]}}\n\n';
          contentType = "text/event-stream";
        }
      } else if (pathname === "/v1/chat/completions") {
        body = 'data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n';
        contentType = "text/event-stream";
      }
      response.writeHead(200, { "Content-Type": contentType });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("production receiver did not expose a TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function requestHeader(request: CapturedRequest, name: string): string | undefined {
  return request.headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];
}

function assertProfileUserAgent(request: CapturedRequest, profile: "cli" | "ide"): void {
  const userAgent = requestHeader(request, "user-agent") ?? "";
  assert.equal(
    userAgent.startsWith(profile === "cli" ? "antigravity/cli/" : "antigravity/"),
    true,
    `missing ${profile} production user-agent on ${request.url}`
  );
}

test("fetch boundary rejects a local redirect to an unapproved destination", async (t) => {
  const receiver = await startLocalReceiver();
  t.after(() => receiver.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error("external network is disabled in synthetic compatibility tests");
    }
    return originalFetch(input, { ...init, redirect: "error" });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    fetch(`${receiver.baseUrl}/redirect`, { method: "POST", body: "{}" }),
    /fetch failed/i
  );
  assert.equal(receiver.requests.length, 0);
});

test("smoke live mode blocks before creating a receiver or synthetic pass", async () => {
  const script = path.join(ROOT, "scripts/ad-hoc/antigravity-compat-smoke.mjs");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          script,
          "--live",
          "--profile",
          "cli",
          "--surface",
          "content",
          "--confirm-authorized-account",
        ],
        { env: { ...process.env, ANTIGRAVITY_COMPAT_LIVE: "1" } },
        (_error, stdout, stderr) => resolve({ code: _error?.code ?? 0, stdout, stderr })
      );
    }
  );
  assert.equal(result.code, 3);
  assert.equal(result.stdout.includes('"status":"pass"'), false);
  assert.match(result.stderr, /"liveValidation":"not_run"/);
  assert.match(result.stderr, /"result":"blocked"/);
});

test("production classifier keeps its transport class", () => {
  assert.equal(
    classifyAntigravityCompatibilityError(503, "upstream unavailable", "antigravity"),
    "transport"
  );
});

test("comparator projection retains unexpected final headers for rejection", () => {
  const expected = expectedProjection("http://127.0.0.1:1", expectedBody(), "cli");
  const captured: CapturedRequest = {
    method: expected.method,
    url: "/v1internal:streamGenerateContent?alt=sse",
    httpVersion: expected.httpVersion,
    headers: [...expected.headers, ["x-new-header", "unexpected"]],
    bodyUtf8: expected.bodyUtf8,
  };
  const projected = comparatorProjection(captured);
  assert.equal(projected.headers.length, captured.headers.length);
  const differences = compareObservedRequests(expected, projected);
  assert.ok(differences.some((difference) => difference.path === "/headers"));
});

test("CLI and IDE contexts preserve profile-specific final requests at a local receiver", async (t) => {
  const receiver = await startLocalReceiver();
  t.after(() => receiver.close());

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error("external network is disabled in synthetic compatibility tests");
    }
    return originalFetch(input, { ...init, redirect: "error" });
  }) as typeof fetch;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  const originalCliCompatProviders = getCliCompatProviders();
  t.after(() => {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    setCliCompatProviders(originalCliCompatProviders);
  });
  setCliCompatProviders([]);

  const expectedProfiles: Array<{ profile: "cli" | "ide"; version: string }> = [
    { profile: "cli", version: "1.1.5" },
    { profile: "ide", version: "2.1.1" },
  ];

  try {
    for (const { profile, version } of expectedProfiles) {
      const manifest = readManifest(profile);
      const credentials = credentialsFor(profile, version);
      const context = persistedContext(profile, version);
      assert.equal(manifest.profile, profile);
      assert.equal(manifest.contractId, context.contractId);
      assert.equal(manifest.source, "synthetic-only");

      const executor = new AntigravityExecutor();
      executor.config.baseUrls = [receiver.baseUrl];
      const result = await executor.execute({
        model: "antigravity/gemini-2.5-flash",
        body: structuredClone(canonicalSemanticRequest),
        stream: true,
        credentials,
        log: { debug() {}, warn() {}, info() {} },
      });
      assert.equal(result.response.status, 200);
      assert.equal(await result.response.text(), STREAM_BODY);

      const captured = receiver.requests.at(-1);
      assert.ok(captured, `missing captured request for ${profile}`);
      assertProfileHeaders(captured, profile);

      const actualBody = JSON.parse(captured.bodyUtf8) as Record<string, unknown>;
      const actualRequest = actualBody.request as Record<string, unknown>;
      assert.deepEqual(actualBody.project, canonicalSemanticRequest.project);
      assert.deepEqual(actualRequest.contents, canonicalSemanticRequest.request.contents);
      assert.equal(actualBody.model, "gemini-2.5-flash");
      assert.equal(actualBody.userAgent, "antigravity");
      assert.equal(actualBody.requestType, "agent");
      assert.deepEqual(actualRequest.generationConfig, {
        topK: 40,
        topP: 1,
        maxOutputTokens: 16,
      });
      assert.equal(typeof actualBody.requestId, "string");
      assert.equal(typeof actualRequest.sessionId, "string");

      const comparatorRules = manifest.dynamicRules.map((rule) => ({
        ...rule,
        path: rule.path === "/headers/2/1" ? "/headers/7/1" : rule.path,
        headerName: "authorization",
        scheme: "Bearer",
      }));
      const expected = expectedProjection(`${receiver.baseUrl}`, expectedBody(), profile);
      const expectedHeaders = expected.headers;
      assert.deepEqual(
        captured.headers.map(([name, value]) => [name.toLowerCase(), value]),
        expectedHeaders
      );
      const differences = compareObservedRequests(
        expected,
        {
          ...comparatorProjection(captured),
          url: `${receiver.baseUrl}${captured.url}`,
        },
        [
          ...comparatorRules,
          { path: "/body/requestId", kind: "request-id", format: "opaque" },
          { path: "/body/request/sessionId", kind: "session-id", format: "opaque" },
        ]
      );
      assert.deepEqual(differences, [], `wire mismatch for ${profile}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    setCliCompatProviders(originalCliCompatProviders);
  }
});

test("legacy profile-only executor dispatch stays local and uses deterministic fallback identity", async (t) => {
  const receiver = await startLocalReceiver();
  const originalFetch = globalThis.fetch;
  const originalCreditsMode = process.env.ANTIGRAVITY_CREDITS;
  const externalDiscoveryUrls: string[] = [];
  const fetchedVersion = "9.9.9";

  t.after(async () => {
    globalThis.fetch = originalFetch;
    clearAntigravityVersionCaches();
    if (originalCreditsMode === undefined) delete process.env.ANTIGRAVITY_CREDITS;
    else process.env.ANTIGRAVITY_CREDITS = originalCreditsMode;
    await receiver.close();
  });

  process.env.ANTIGRAVITY_CREDITS = "off";
  clearAntigravityVersionCaches();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${receiver.baseUrl}/`)) {
      return originalFetch(input, { ...init, redirect: "error" });
    }
    externalDiscoveryUrls.push(url);
    return new Response(JSON.stringify({ tag_name: fetchedVersion }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const credentials = {
    accessToken: "fixturetoken",
    projectId: "synthetic-project",
    connectionId: "legacy-profile-only",
    providerSpecificData: { clientProfile: "cli" },
  };
  const executor = new AntigravityExecutor();
  executor.config.baseUrls = [receiver.baseUrl];
  const result = await executor.execute({
    model: "antigravity/gemini-2.5-flash",
    body: structuredClone(canonicalSemanticRequest),
    stream: true,
    credentials,
    log: { debug() {}, warn() {}, info() {} },
  });

  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), STREAM_BODY);
  assert.deepEqual(externalDiscoveryUrls, []);
  const captured = receiver.requests.at(-1);
  assert.ok(captured, "missing captured request for profile-only credential");
  assert.equal(requestHeader(captured, "user-agent"), EXPECTED_CLI_USER_AGENT);
  assert.equal(requestHeader(captured, "user-agent")?.includes(fetchedVersion), false);
});

test("complete persisted null-version executor dispatch ignores divergent header cache", async (t) => {
  const receiver = await startLocalReceiver();
  const originalFetch = globalThis.fetch;
  const originalCreditsMode = process.env.ANTIGRAVITY_CREDITS;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    clearAntigravityVersionCaches();
    if (originalCreditsMode === undefined) delete process.env.ANTIGRAVITY_CREDITS;
    else process.env.ANTIGRAVITY_CREDITS = originalCreditsMode;
    await receiver.close();
  });

  process.env.ANTIGRAVITY_CREDITS = "off";
  clearAntigravityVersionCaches();
  seedAntigravityCliVersionCache("9.9.9");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error(`external network is disabled in complete persisted-context test: ${url}`);
    }
    return originalFetch(input, { ...init, redirect: "error" });
  }) as typeof fetch;

  const executor = new AntigravityExecutor();
  executor.config.baseUrls = [receiver.baseUrl];
  const result = await executor.execute({
    model: "antigravity/gemini-2.5-flash",
    body: structuredClone(canonicalSemanticRequest),
    stream: true,
    credentials: {
      accessToken: "fixturetoken",
      projectId: "synthetic-project",
      connectionId: "complete-null-context",
      providerSpecificData: {
        clientProfile: "cli",
        clientContractId: "antigravity-wire-cli-synthetic-v1",
        clientObservedVersion: null,
        clientVersionState: "unverified",
        clientContextSource: "credential",
      },
    },
    log: { debug() {}, warn() {}, info() {} },
  });

  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), STREAM_BODY);
  const captured = receiver.requests.at(-1);
  assert.ok(captured, "missing captured request for complete persisted context");
  assert.equal(requestHeader(captured, "user-agent"), EXPECTED_CLI_USER_AGENT);
  assert.equal(requestHeader(captured, "user-agent")?.includes("9.9.9"), false);
});

test("verified durable AgentBridge binding selects the persisted CLI or IDE executor identity", async (t) => {
  const harness = await createChatPipelineHarness("agent-bridge-durable-profile");
  const providersDb = await import("../../src/lib/db/providers.ts");
  const agentBridgeState = await import("../../src/lib/db/agentBridgeState.ts");
  const routingContext = await import("../../src/mitm/agentBridgeRoutingContext.ts");
  const receiver = await startProductionReceiver();
  const originalFetch = globalThis.fetch;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  const originalCreditsMode = process.env.ANTIGRAVITY_CREDITS;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    if (originalCreditsMode === undefined) delete process.env.ANTIGRAVITY_CREDITS;
    else process.env.ANTIGRAVITY_CREDITS = originalCreditsMode;
    clearAntigravityVersionCaches();
    await receiver.close();
    await harness.cleanup();
  });

  process.env.ANTIGRAVITY_CREDITS = "off";
  PROVIDERS.antigravity.baseUrls = [receiver.baseUrl];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error(`external network is disabled in durable AgentBridge test: ${request.url}`);
    }
    return originalFetch(request, { redirect: "error" });
  }) as typeof fetch;

  for (const profile of ["cli", "ide"] as const) {
    await harness.resetStorage();
    receiver.requests.length = 0;
    const version = profile === "cli" ? "1.1.5" : "2.1.1";
    if (profile === "cli") seedAntigravityCliVersionCache(version);
    else seedAntigravityIdeVersionCache(version);

    const bound = await providersDb.createProviderConnection({
      provider: profile === "cli" ? "agy" : "antigravity",
      authType: "oauth",
      name: `bound-${profile}`,
      email: `bound-${profile}@example.test`,
      accessToken: `bound-${profile}-token`,
      refreshToken: `bound-${profile}-refresh`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      projectId: "synthetic-project",
      providerSpecificData: {
        ...credentialsFor(profile, version).providerSpecificData,
        projectId: "synthetic-project",
      },
      isActive: true,
      testStatus: "active",
      priority: 1,
    });
    const sibling = await providersDb.createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name: `sibling-${profile}`,
      email: `sibling-${profile}@example.test`,
      accessToken: `sibling-${profile}-token`,
      refreshToken: `sibling-${profile}-refresh`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      projectId: "synthetic-project",
      providerSpecificData: {
        ...credentialsFor(profile === "cli" ? "ide" : "cli", version).providerSpecificData,
        projectId: "synthetic-project",
      },
      isActive: true,
      testStatus: "active",
      priority: 0,
    });
    assert.ok(bound && sibling);
    await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", bound.id);
    const secret = routingContext.rotateAgentBridgeRoutingContextSecret();
    const proof = routingContext.createAgentBridgeRoutingContextAssertion({
      secret,
      agent: "antigravity",
      connectionId: bound.id,
      path: "/v1/chat/completions",
    });

    const response = await harness.handleChat(
      harness.buildRequest({
        body: {
          model: "antigravity/gemini-2.5-flash",
          stream: false,
          messages: [{ role: "user", content: "durable binding probe" }],
        },
        headers: {
          "x-omniroute-source": "agent-bridge",
          "x-omniroute-agent": "antigravity",
          "x-omniroute-agent-bridge-proof": proof,
        },
      })
    );

    assert.equal(response.status, 200);
    const finalRequests = receiver.requests.filter((request) =>
      request.url.startsWith("/v1internal:streamGenerateContent")
    );
    assert.equal(finalRequests.length, 1, "only the bound connection may reach the executor");
    const finalRequest = finalRequests[0];
    assert.equal(
      requestHeader(finalRequest, "authorization"),
      `Bearer bound-${profile}-token`,
      "final executor must use the durable bound connection"
    );
    assert.equal(
      requestHeader(finalRequest, "user-agent"),
      profile === "cli" ? EXPECTED_CLI_USER_AGENT : "antigravity/ide/2.1.1 darwin/arm64",
      "final executor UA must come from bound providerSpecificData"
    );
  }
});

test("verified direct AgentBridge binding overrides a sibling session-affinity pin", async (t) => {
  const harness = await createChatPipelineHarness("agent-bridge-direct-affinity-pin");
  const providersDb = await import("../../src/lib/db/providers.ts");
  const agentBridgeState = await import("../../src/lib/db/agentBridgeState.ts");
  const routingContext = await import("../../src/mitm/agentBridgeRoutingContext.ts");
  const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
  const receiver = await startProductionReceiver();
  const originalFetch = globalThis.fetch;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    clearAntigravityVersionCaches();
    await receiver.close();
    await harness.cleanup();
  });

  PROVIDERS.antigravity.baseUrls = [receiver.baseUrl];
  seedAntigravityCliVersionCache("1.1.5");
  seedAntigravityIdeVersionCache("2.1.1");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input.url);
    if (!url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error(`external network is disabled in direct AgentBridge affinity test: ${url}`);
    }
    return originalFetch(url, { ...init, redirect: "error" });
  }) as typeof fetch;
  await harness.settingsDb.updateSettings({ sessionAffinityTtlMs: 60_000 });

  const bound = await providersDb.createProviderConnection({
    provider: "agy",
    authType: "oauth",
    name: "direct-affinity-bound-cli",
    email: "direct-affinity-bound-cli@example.test",
    accessToken: "direct-affinity-bound-cli-token",
    refreshToken: "direct-affinity-bound-cli-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("cli", "1.1.5").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  const sibling = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "direct-affinity-sibling-ide",
    email: "direct-affinity-sibling-ide@example.test",
    accessToken: "direct-affinity-sibling-ide-token",
    refreshToken: "direct-affinity-sibling-ide-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("ide", "2.1.1").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  assert.ok(bound && sibling);
  await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", bound.id);
  affinityDb.upsertSessionAccountAffinity(
    "header:agent-bridge-direct-affinity",
    "antigravity",
    sibling.id,
    Date.now(),
    60_000
  );
  const secret = routingContext.rotateAgentBridgeRoutingContextSecret();
  const proof = routingContext.createAgentBridgeRoutingContextAssertion({
    secret,
    agent: "antigravity",
    connectionId: bound.id,
    path: "/v1/chat/completions",
  });

  const response = await harness.handleChat(
    harness.buildRequest({
      body: {
        model: "antigravity/gemini-2.5-flash",
        stream: false,
        messages: [{ role: "user", content: "direct affinity pin probe" }],
      },
      headers: {
        "x-session-id": "agent-bridge-direct-affinity",
        "x-omniroute-source": "agent-bridge",
        "x-omniroute-agent": "antigravity",
        "x-omniroute-agent-bridge-proof": proof,
      },
    })
  );

  assert.equal(response.status, 200);
  const finalRequests = receiver.requests.filter((request) =>
    request.url.startsWith("/v1internal:streamGenerateContent")
  );
  assert.equal(
    finalRequests.length,
    1,
    "direct verified request must issue one pinned upstream request"
  );
  assert.equal(
    requestHeader(finalRequests[0], "authorization"),
    "Bearer direct-affinity-bound-cli-token",
    "verified direct binding must override a sibling session-affinity pin"
  );
  assert.equal(requestHeader(finalRequests[0], "user-agent"), EXPECTED_CLI_USER_AGENT);
});

test("verified AgentBridge binding overrides a combo sibling target", async (t) => {
  const harness = await createChatPipelineHarness("agent-bridge-combo-pin");
  const providersDb = await import("../../src/lib/db/providers.ts");
  const agentBridgeState = await import("../../src/lib/db/agentBridgeState.ts");
  const routingContext = await import("../../src/mitm/agentBridgeRoutingContext.ts");
  const receiver = await startProductionReceiver();
  const originalFetch = globalThis.fetch;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    clearAntigravityVersionCaches();
    await receiver.close();
    await harness.cleanup();
  });

  PROVIDERS.antigravity.baseUrls = [receiver.baseUrl];
  seedAntigravityCliVersionCache("1.1.5");
  seedAntigravityIdeVersionCache("2.1.1");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input.url);
    if (!url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error(`external network is disabled in AgentBridge combo test: ${url}`);
    }
    return originalFetch(url, { ...init, redirect: "error" });
  }) as typeof fetch;

  const bound = await providersDb.createProviderConnection({
    provider: "agy",
    authType: "oauth",
    name: "combo-bound-cli",
    email: "combo-bound-cli@example.test",
    accessToken: "combo-bound-cli-token",
    refreshToken: "combo-bound-cli-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("cli", "1.1.5").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  const sibling = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "combo-sibling-ide",
    email: "combo-sibling-ide@example.test",
    accessToken: "combo-sibling-ide-token",
    refreshToken: "combo-sibling-ide-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("ide", "2.1.1").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  assert.ok(bound && sibling);
  await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", bound.id);
  await harness.combosDb.createCombo({
    name: "agent-bridge-combo-pin",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      {
        id: "sibling-target",
        kind: "model",
        provider: "antigravity",
        providerId: "antigravity",
        model: "gemini-2.5-flash",
        connectionId: sibling.id,
      },
    ],
  });
  const secret = routingContext.rotateAgentBridgeRoutingContextSecret();
  const proof = routingContext.createAgentBridgeRoutingContextAssertion({
    secret,
    agent: "antigravity",
    connectionId: bound.id,
    path: "/v1/chat/completions",
  });

  const response = await harness.handleChat(
    harness.buildRequest({
      body: {
        model: "agent-bridge-combo-pin",
        stream: false,
        messages: [{ role: "user", content: "combo pin probe" }],
      },
      headers: {
        "x-omniroute-source": "agent-bridge",
        "x-omniroute-agent": "antigravity",
        "x-omniroute-agent-bridge-proof": proof,
      },
    })
  );

  assert.equal(response.status, 200);
  const finalRequests = receiver.requests.filter((request) =>
    request.url.startsWith("/v1internal:streamGenerateContent")
  );
  assert.equal(finalRequests.length, 1, "combo must issue one pinned upstream request");
  assert.equal(
    requestHeader(finalRequests[0], "authorization"),
    "Bearer combo-bound-cli-token",
    "verified binding must override a combo sibling target"
  );
  assert.equal(requestHeader(finalRequests[0], "user-agent"), EXPECTED_CLI_USER_AGENT);
});

test("verified AgentBridge safety-net redirect pins its bound connection without bypassing an open breaker", async (t) => {
  const harness = await createChatPipelineHarness("agent-bridge-safety-net-pin");
  const providersDb = await import("../../src/lib/db/providers.ts");
  const agentBridgeState = await import("../../src/lib/db/agentBridgeState.ts");
  const routingContext = await import("../../src/mitm/agentBridgeRoutingContext.ts");
  const { getCircuitBreaker, STATE } = await import("../../src/shared/utils/circuitBreaker.ts");
  const receiver = await startProductionReceiver();
  const originalFetch = globalThis.fetch;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    clearAntigravityVersionCaches();
    await receiver.close();
    await harness.cleanup();
  });

  PROVIDERS.antigravity.baseUrls = [receiver.baseUrl];
  seedAntigravityCliVersionCache("1.1.5");
  seedAntigravityIdeVersionCache("2.1.1");
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input.url);
    if (!url.startsWith(`${receiver.baseUrl}/`)) {
      throw new Error(`external network is disabled in AgentBridge safety-net test: ${url}`);
    }
    return originalFetch(url, { ...init, redirect: "error" });
  }) as typeof fetch;

  const bound = await providersDb.createProviderConnection({
    provider: "agy",
    authType: "oauth",
    name: "safety-net-bound-cli",
    email: "safety-net-bound-cli@example.test",
    accessToken: "safety-net-bound-cli-token",
    refreshToken: "safety-net-bound-cli-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("cli", "1.1.5").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  const sibling = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "safety-net-sibling-ide",
    email: "safety-net-sibling-ide@example.test",
    accessToken: "safety-net-sibling-ide-token",
    refreshToken: "safety-net-sibling-ide-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("ide", "2.1.1").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  assert.ok(bound && sibling);
  await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", bound.id);
  await harness.combosDb.createCombo({
    name: "agent-bridge-safety-net-outer",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [{ provider: "auto", model: "safety-net-binding" }],
  });
  await harness.combosDb.createCombo({
    name: "auto/best-safety-net-binding",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: [
      {
        id: "safety-net-sibling-target",
        kind: "model",
        provider: "antigravity",
        providerId: "antigravity",
        model: "gemini-2.5-flash",
        connectionId: sibling.id,
      },
    ],
  });
  const secret = routingContext.rotateAgentBridgeRoutingContextSecret();
  const makeVerifiedRequest = (signal?: AbortSignal) => {
    const proof = routingContext.createAgentBridgeRoutingContextAssertion({
      secret,
      agent: "antigravity",
      connectionId: bound.id,
      path: "/v1/chat/completions",
    });
    const baseRequest = harness.buildRequest({
      body: {
        model: "agent-bridge-safety-net-outer",
        stream: false,
        messages: [{ role: "user", content: "safety-net pin probe" }],
      },
      headers: {
        "x-internal-test": "combo-health-check",
        "x-omniroute-source": "agent-bridge",
        "x-omniroute-agent": "antigravity",
        "x-omniroute-agent-bridge-proof": proof,
      },
    });
    return signal ? new Request(baseRequest, { signal }) : baseRequest;
  };

  const pinnedResponse = await harness.handleChat(makeVerifiedRequest());

  assert.equal(pinnedResponse.status, 200);
  const finalRequests = receiver.requests.filter((request) =>
    request.url.startsWith("/v1internal:streamGenerateContent")
  );
  assert.equal(
    finalRequests.length,
    1,
    "safety-net redirect must issue one pinned upstream request"
  );
  assert.equal(
    requestHeader(finalRequests[0], "authorization"),
    "Bearer safety-net-bound-cli-token",
    "verified binding must override the nested combo sibling target"
  );
  assert.equal(requestHeader(finalRequests[0], "user-agent"), EXPECTED_CLI_USER_AGENT);

  const breaker = getCircuitBreaker("antigravity");
  breaker.state = STATE.OPEN;
  breaker.lastFailureTime = Date.now();
  breaker.resetTimeout = 60_000;

  const abortedRequest = makeVerifiedRequest(AbortSignal.timeout(80));
  const blockedResponse = await harness.handleChat(abortedRequest);

  assert.equal(
    blockedResponse.status,
    499,
    "verified safety-net route must stop while its breaker is open"
  );
  assert.equal(
    receiver.requests.filter((request) =>
      request.url.startsWith("/v1internal:streamGenerateContent")
    ).length,
    1,
    "verified safety-net route must not bypass the open breaker or dispatch a sibling"
  );
});

test("verified AgentBridge binding suppresses emergency provider fallback", async (t) => {
  const harness = await createChatPipelineHarness("agent-bridge-emergency-fallback");
  const providersDb = await import("../../src/lib/db/providers.ts");
  const agentBridgeState = await import("../../src/lib/db/agentBridgeState.ts");
  const routingContext = await import("../../src/mitm/agentBridgeRoutingContext.ts");
  const receiver = await startProductionReceiver();
  const originalFetch = globalThis.fetch;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  const originalEmergencyFallback = process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    if (originalEmergencyFallback === undefined) delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
    else process.env.OMNIROUTE_EMERGENCY_FALLBACK = originalEmergencyFallback;
    clearAntigravityVersionCaches();
    await receiver.close();
    await harness.cleanup();
  });

  process.env.OMNIROUTE_EMERGENCY_FALLBACK = "true";
  PROVIDERS.antigravity.baseUrls = [receiver.baseUrl];
  seedAntigravityCliVersionCache("1.1.5");
  const dispatchedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    dispatchedUrls.push(request.url);
    if (request.headers.get("authorization") === "Bearer emergency-bound-token") {
      return new Response(JSON.stringify({ error: { message: "payment required" } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!request.url.startsWith(`${receiver.baseUrl}/`)) {
      return originalFetch(`${receiver.baseUrl}${new URL(request.url).pathname}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "error",
      });
    }
    return originalFetch(request, { redirect: "error" });
  }) as typeof fetch;

  const bound = await providersDb.createProviderConnection({
    provider: "agy",
    authType: "oauth",
    name: "emergency-bound-cli",
    email: "emergency-bound-cli@example.test",
    accessToken: "emergency-bound-token",
    refreshToken: "emergency-bound-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "synthetic-project",
    providerSpecificData: { ...credentialsFor("cli", "1.1.5").providerSpecificData },
    isActive: true,
    testStatus: "active",
  });
  const fallback = await providersDb.createProviderConnection({
    provider: "nvidia",
    authType: "apikey",
    name: "emergency-unrelated-fallback",
    apiKey: "emergency-fallback-token",
    providerSpecificData: {},
    isActive: true,
    testStatus: "active",
  });
  assert.ok(bound && fallback);
  await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", bound.id);
  const secret = routingContext.rotateAgentBridgeRoutingContextSecret();
  const proof = routingContext.createAgentBridgeRoutingContextAssertion({
    secret,
    agent: "antigravity",
    connectionId: bound.id,
    path: "/v1/chat/completions",
  });

  const response = await harness.handleChat(
    harness.buildRequest({
      body: {
        model: "antigravity/gemini-2.5-flash",
        stream: false,
        messages: [{ role: "user", content: "no emergency fallback" }],
      },
      headers: {
        "x-omniroute-source": "agent-bridge",
        "x-omniroute-agent": "antigravity",
        "x-omniroute-agent-bridge-proof": proof,
      },
    })
  );

  assert.equal(response.status, 402);
  assert.equal(
    dispatchedUrls.some((url) => /nvidia|integrate\.api\.nvidia\.com/i.test(url)),
    false,
    "verified binding must never dispatch the unrelated emergency fallback provider"
  );
});

test("production adapter matrix propagates each persisted profile through local surfaces", async (t) => {
  const receiver = await startProductionReceiver();
  t.after(() => receiver.close());
  const originalFetch = globalThis.fetch;
  const originalCreditsMode = process.env.ANTIGRAVITY_CREDITS;
  const originalBaseUrls = [...(PROVIDERS.antigravity.baseUrls ?? [])];
  const imageProvider = getImageProvider("antigravity");
  const originalImageBaseUrl = imageProvider?.baseUrl;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalCreditsMode === undefined) delete process.env.ANTIGRAVITY_CREDITS;
    else process.env.ANTIGRAVITY_CREDITS = originalCreditsMode;
    PROVIDERS.antigravity.baseUrls = originalBaseUrls;
    if (imageProvider && originalImageBaseUrl !== undefined) {
      imageProvider.baseUrl = originalImageBaseUrl;
    }
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const source = new URL(String(input instanceof Request ? input.url : input));
    const mappedUrl =
      source.hostname === "127.0.0.1"
        ? source.toString()
        : `${receiver.baseUrl}${source.pathname}${source.search}`;
    return originalFetch(mappedUrl, { ...init, redirect: "error" });
  }) as typeof fetch;
  PROVIDERS.antigravity.baseUrls = [receiver.baseUrl];
  seedAntigravityCliVersionCache("1.1.5");
  seedAntigravityIdeVersionCache("2.1.1");
  t.after(() => clearAntigravityVersionCaches());

  const profiles: Array<{
    profile: "cli" | "ide";
    provider: "agy" | "antigravity";
    version: string;
  }> = [
    { profile: "cli", provider: "agy", version: "1.1.5" },
    { profile: "ide", provider: "antigravity", version: "2.1.1" },
  ];

  for (const { profile, provider, version } of profiles) {
    const credentials = credentialsFor(profile, version);
    const providerSpecificData = credentials.providerSpecificData;

    const oauthConfig = {
      ...ANTIGRAVITY_CONFIG,
      tokenUrl: `${receiver.baseUrl}/oauth/token`,
      userInfoUrl: `${receiver.baseUrl}/oauth/userinfo`,
      loadCodeAssistEndpoints: [`${receiver.baseUrl}/v1internal:loadCodeAssist`],
      onboardUserEndpoints: [],
    };
    const oauthProvider = createAntigravityOAuthProvider(oauthConfig, profile);
    const oauthTokens = await oauthProvider.exchangeToken(
      oauthConfig,
      "fixture-code",
      `${receiver.baseUrl}/oauth/callback`
    );
    const oauthTokenRequest = receiver.requests.find((request) => request.url === "/oauth/token");
    assert.ok(oauthTokenRequest, `missing OAuth token request for ${profile}`);
    assertProfileUserAgent(oauthTokenRequest, profile);
    await oauthProvider.postExchange(oauthTokens);
    const oauthBootstrap = receiver.requests.find(
      (request) => request.url === "/v1internal:loadCodeAssist"
    );
    assert.ok(oauthBootstrap, `missing OAuth bootstrap request for ${profile}`);
    assertProfileUserAgent(oauthBootstrap, profile);

    const bootstrapToken = `bootstrap-${profile}-token`;
    await ensureAntigravityProjectAssigned(
      bootstrapToken,
      async (url, init) => {
        const source = new URL(url);
        return originalFetch(`${receiver.baseUrl}${source.pathname}${source.search}`, {
          ...init,
          redirect: "error",
        });
      },
      profile,
      undefined,
      persistedContext(profile, version)
    );
    const bootstrapRequest = receiver.requests.at(-1);
    assert.ok(bootstrapRequest, `missing injected bootstrap request for ${profile}`);
    assertProfileUserAgent(bootstrapRequest, profile);

    const usageStart = receiver.requests.length;
    await getAntigravityUsage(
      provider,
      `usage-${profile}-token`,
      providerSpecificData,
      "synthetic-project",
      `usage-${profile}-connection`,
      { forceRefresh: true }
    );
    const usageRequests = receiver.requests.slice(usageStart);
    assert.ok(
      usageRequests.length >= 4,
      `usage matrix did not call production fetchers for ${profile}`
    );
    for (const request of usageRequests) assertProfileUserAgent(request, profile);

    process.env.ANTIGRAVITY_CREDITS = "always";
    const creditsStart = receiver.requests.length;
    const executor = new AntigravityExecutor();
    executor.config.baseUrls = [receiver.baseUrl];
    const creditsResult = await executor.execute({
      model: "antigravity/gemini-2.5-flash",
      body: structuredClone(canonicalSemanticRequest),
      stream: true,
      credentials,
      log: { debug() {}, warn() {}, info() {} },
    });
    assert.equal(creditsResult.response.status, 200);
    const creditsRequest = receiver.requests.slice(creditsStart).at(-1);
    assert.ok(creditsRequest, `missing credits request for ${profile}`);
    assertProfileUserAgent(creditsRequest, profile);
    assert.deepEqual(
      (JSON.parse(creditsRequest.bodyUtf8) as Record<string, unknown>).enabledCreditTypes,
      ["GOOGLE_ONE_AI"]
    );

    if (imageProvider) {
      imageProvider.baseUrl = `${receiver.baseUrl}/v1internal:streamGenerateContent?alt=sse`;
    }
    const imageStart = receiver.requests.length;
    const imageResult = await handleImageGeneration({
      body: { model: "antigravity/gemini-3.1-flash-image", prompt: "compatibility probe" },
      credentials,
      log: { info() {}, error() {} },
    });
    assert.equal(imageResult.success, true);
    const imageRequest = receiver.requests.slice(imageStart).at(-1);
    assert.ok(imageRequest, `missing image request for ${profile}`);
    assertProfileUserAgent(imageRequest, profile);
    assert.equal(
      (JSON.parse(imageRequest.bodyUtf8) as Record<string, unknown>).requestType,
      "image_gen"
    );

    const mitmStart = receiver.requests.length;
    const previousRouterUrl = process.env.OMNIROUTE_BASE_URL;
    process.env.OMNIROUTE_BASE_URL = receiver.baseUrl;
    const responseState = { headersSent: false, chunks: [] as string[] };
    const response = {
      get headersSent() {
        return responseState.headersSent;
      },
      writeHead() {
        responseState.headersSent = true;
      },
      write(chunk: Buffer | string) {
        responseState.chunks.push(String(chunk));
        return true;
      },
      end(chunk?: Buffer | string) {
        if (chunk) responseState.chunks.push(String(chunk));
      },
    } as unknown as Parameters<AntigravityHandler["intercept"]>[1];
    const request = {
      url: "/v1internal:streamGenerateContent?alt=sse",
      headers: {
        host: "cloudcode-pa.googleapis.com",
        "user-agent": `forged-${profile}/99.0`,
        "x-client-profile": profile,
      },
    } as unknown as Parameters<AntigravityHandler["intercept"]>[0];
    try {
      await new AntigravityHandler().intercept(
        request,
        response,
        Buffer.from(
          JSON.stringify({
            request: { contents: [{ role: "user", parts: [{ text: "probe" }] }] },
          })
        ),
        "antigravity/gemini-2.5-flash"
      );
    } finally {
      if (previousRouterUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
      else process.env.OMNIROUTE_BASE_URL = previousRouterUrl;
    }
    const mitmRequest = receiver.requests.slice(mitmStart).at(-1);
    assert.ok(mitmRequest, `missing MITM router request for ${profile}`);
    assert.equal(requestHeader(mitmRequest, "x-omniroute-source"), "agent-bridge");
    assert.equal(requestHeader(mitmRequest, "x-omniroute-agent"), "antigravity");
    assert.equal(requestHeader(mitmRequest, "x-client-profile"), undefined);
    assert.notEqual(
      requestHeader(mitmRequest, "user-agent"),
      profile === "cli" ? EXPECTED_CLI_USER_AGENT : "antigravity/ide/2.1.1 darwin/arm64",
      "MITM router transport user-agent must not impersonate final executor identity"
    );
  }
});
