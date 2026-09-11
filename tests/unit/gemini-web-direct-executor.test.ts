import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GeminiWebExecutor,
  clearGeminiWebSessionCache,
  resolveStaticSessionTokens,
  DEFAULT_GEMINI_WEB_BUILD_LABEL,
  GeminiWebAuthRequiredError,
} from "../../open-sse/executors/gemini-web.ts";
import { updateProviderConnectionCas } from "../../src/lib/db/providers.ts";
import { GEMINI_DEEP_THINK_TIMEOUT_CODE } from "../../open-sse/config/constants.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/deep-think-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const MOCK_HTML_SESSION = `
  <!DOCTYPE html>
  <html>
  <head>
    <script>
      window.WIZ_global_data = {
        "SNlM0e": "AOvx0lMockAtToken:1789047456",
        "FdrFJe": "-7998873305294431664",
        "cfb2h": "boq_assistant-bard-web-server_20260907.07_p0"
      };
    </script>
  </head>
  <body></body>
  </html>
`;

interface CompletionResponseShape {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
}

interface ErrorResponseBodyShape {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
}

describe("GeminiWebExecutor Direct API (gemini-deep-think)", () => {
  beforeEach(() => {
    clearGeminiWebSessionCache();
  });

  it("completes full end-to-end flow with synthetic fetch without Playwright", async () => {
    const urlsCalled: string[] = [];
    let pollCount = 0;

    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urlsCalled.push(url);

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
            "Set-Cookie": "__Secure-1PSIDTS=rotated-ts-123; Path=/; Domain=.google.com; Secure",
          },
        });
      }

      if (url.includes("batchexecute") && url.includes("hNvQHb")) {
        pollCount++;
        if (pollCount === 1) {
          return new Response(fixture.pollPendingResponse, {
            status: 200,
            headers: { "Content-Type": "text/plain;charset=utf-8" },
          });
        }
        return new Response(fixture.pollCompletedResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    let refreshedCredentials: Record<string, unknown> | null = null;
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "What is the capital of France?" }],
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid; __Secure-1PSIDTS=test-ts",
        providerSpecificData: { pollIntervalMs: 5 },
      },
      signal: AbortSignal.timeout(10000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
      onCredentialsRefreshed: async (creds) => {
        refreshedCredentials = creds;
      },
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as CompletionResponseShape;
    assert.equal(json.model, "gemini-deep-think");
    assert.equal(json.choices[0].message.content, "Paris");
    assert.equal(json.choices[0].finish_reason, "stop");

    assert.ok(
      urlsCalled.some((u) => u.includes("/app")),
      "Must bootstrap session via /app"
    );
    assert.ok(
      urlsCalled.some((u) => u.includes("StreamGenerate")),
      "Must post to StreamGenerate"
    );
    assert.ok(
      urlsCalled.some((u) => u.includes("batchexecute")),
      "Must poll via batchexecute"
    );
    assert.ok(pollCount >= 2, "Must have polled at least twice (pending then completed)");

    // Rotated cookies persisted from Set-Cookie
    assert.ok(refreshedCredentials !== null, "Must have called onCredentialsRefreshed");
    assert.ok(
      String((refreshedCredentials as Record<string, unknown> | null)?.apiKey).includes(
        "__Secure-1PSIDTS=rotated-ts-123"
      ),
      "Must have merged rotated __Secure-1PSIDTS"
    );
  });

  it("handles streaming response format (pseudo-streaming SSE chunk)", async () => {
    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "What is the capital of France?" }],
        stream: true,
      },
      stream: true,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: { pollIntervalMs: 5 },
      },
      signal: AbortSignal.timeout(10000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get("Content-Type") || "", /text\/event-stream/);

    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    assert.ok(streamText.includes('"content":"Paris"'), "Stream must emit final answer chunk");
    assert.ok(streamText.includes('"finish_reason":"stop"'), "Stream must emit finish stop chunk");
    assert.ok(streamText.includes("data: [DONE]"), "Stream must emit terminal [DONE]");
  });

  it("parses tool calls when requestedTools and tool blocks are present", async () => {
    const escapedTool =
      '<tool>{\\\\\\"name\\\\\\":\\\\\\"lookup\\\\\\",\\\\\\"arguments\\\\\\":{\\\\\\"query\\\\\\":\\\\\\"weather\\\\\\"}}</tool>';
    const pollWithToolBlock = fixture.pollCompletedResponse.replace("Paris", escapedTool);

    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(pollWithToolBlock, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await (
      executor as unknown as {
        executeDirectDeepThink: (params: {
          input: ExecuteInput;
          cookie: string;
          prompt: string;
          modelId: string;
          hasTools: boolean;
          requestedTools: unknown;
        }) => Promise<{ response: Response }>;
      }
    ).executeDirectDeepThink({
      input: {
        model: "gemini-deep-think",
        body: {
          messages: [{ role: "user", content: "What is the weather?" }],
          tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
          stream: false,
        },
        stream: false,
        credentials: {
          apiKey: "__Secure-1PSID=test-sid",
          providerSpecificData: { pollIntervalMs: 5 },
        },
        signal: AbortSignal.timeout(10000),
        log: null,
        fetch: mockFetch as unknown as typeof fetch,
      } as unknown as ExecuteInput,
      cookie: "__Secure-1PSID=test-sid",
      prompt: "What is the weather?",
      modelId: "gemini-deep-think",
      hasTools: true,
      requestedTools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    });

    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as CompletionResponseShape;
    const toolCall = json.choices[0].message.tool_calls?.[0];
    assert.ok(toolCall, "Must have parsed tool_calls from <tool> block");
    assert.equal(toolCall.function.name, "lookup");
    assert.deepEqual(JSON.parse(toolCall.function.arguments), { query: "weather" });
  });

  it("handles session bootstrap failure returning 401 gemini_web_auth_required", async () => {
    const mockFetch = mock.fn(async () => {
      return new Response("<html><body>Sign in to Google</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=expired-cookie" },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 401);
    const json = (await result.response.json()) as ErrorResponseBodyShape;
    assert.equal(json.error.code, "gemini_web_auth_required");
    assert.equal(json.error.type, "authentication_error");
  });

  it("terminates immediately with HTTP 401 gemini_web_auth_required without browser recovery on bootstrap failure even if playwright is provided", async () => {
    const urlsCalled: string[] = [];
    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urlsCalled.push(url);

      if (url.includes("/app")) {
        // Direct bootstrap fails (login redirect or missing session tokens)
        return new Response("<html><body>Sign in to Google</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const mockBrowser = {
      newContext: mock.fn(async () => {}),
      close: mock.fn(async () => {}),
    };

    const mockPlaywright = {
      chromium: {
        launch: mock.fn(async () => mockBrowser),
      },
    };

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "Auth failure test" }],
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid; __Secure-1PSIDTS=stale-ts",
        providerSpecificData: { pollIntervalMs: 5 },
      },
      signal: AbortSignal.timeout(10000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
      playwright: mockPlaywright,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 401);
    const json = (await result.response.json()) as ErrorResponseBodyShape;
    assert.equal(json.error.code, "gemini_web_auth_required");
    assert.equal(json.error.type, "authentication_error");

    assert.equal(
      mockPlaywright.chromium.launch.mock.callCount(),
      0,
      "Must NEVER launch browser for recovery during inference"
    );
    assert.ok(
      !urlsCalled.some((u) => u.includes("StreamGenerate")),
      "Must not post to StreamGenerate after bootstrap auth failure"
    );
  });

  it("terminates with HTTP 401 when bootstrap throws GeminiWebAuthRequiredError", async () => {
    const mockFetch = mock.fn(async () => {
      throw new GeminiWebAuthRequiredError("Unauthorized session", 401);
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Auth test" }], stream: false },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=expired-cookie" },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 401);
    const json = (await result.response.json()) as ErrorResponseBodyShape;
    assert.equal(json.error.code, "gemini_web_auth_required");
    assert.equal(json.error.type, "authentication_error");
    assert.match(json.error.message, /Unauthorized session/);
  });

  it("handles upstream polling failure returning 502 gemini_deep_think_generation_failed", async () => {
    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollFailedResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "complex riddle" }],
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: { pollIntervalMs: 5 },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 502);
    const json = (await result.response.json()) as ErrorResponseBodyShape;
    assert.equal(json.error.code, "gemini_deep_think_generation_failed");
    assert.equal(json.error.type, "server_error");
    assert.match(json.error.message, /wasn't able to finish thinking/i);
  });

  it("handles timeout returning 504 gemini_deep_think_timeout", async () => {
    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollPendingResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "very slow task" }],
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: { timeoutMs: 30, pollIntervalMs: 10 },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 504);
    const json = (await result.response.json()) as ErrorResponseBodyShape;
    assert.equal(json.error.code, GEMINI_DEEP_THINK_TIMEOUT_CODE);
    assert.equal(json.error.type, "timeout_error");
  });

  it("handles cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Request cancelled by client"));

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "cancelled" }],
        stream: false,
      },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=test-sid" },
      signal: controller.signal,
      log: null,
    });

    assert.equal(result.response.status, 500);
    const json = (await result.response.json()) as { error: string };
    assert.ok(!json.error.includes("at /"), "Must not leak stack traces");
  });

  it("reuses cached session tokens across turns with same cookie", async () => {
    let appFetchCount = 0;

    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        appFetchCount++;
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const sharedCreds = {
      apiKey: "__Secure-1PSID=cached-session-sid",
      providerSpecificData: { pollIntervalMs: 5 },
    };

    // First call: fetches /app
    const res1 = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Turn 1" }], stream: false },
      stream: false,
      credentials: sharedCreds,
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);
    assert.equal(res1.response.status, 200);
    assert.equal(appFetchCount, 1);

    // Second call: reuses cached session, does NOT fetch /app again
    const res2 = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Turn 2" }], stream: false },
      stream: false,
      credentials: sharedCreds,
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);
    assert.equal(res2.response.status, 200);
    assert.equal(appFetchCount, 1, "/app should not be re-fetched due to session cache");

    // Clear cache, third call must re-fetch
    clearGeminiWebSessionCache();
    const res3 = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Turn 3" }], stream: false },
      stream: false,
      credentials: sharedCreds,
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);
    assert.equal(res3.response.status, 200);
    assert.equal(appFetchCount, 2, "/app must be re-fetched after cache clear");
  });

  it("captures rotated cookies from bootstrap /app and persists via onCredentialsRefreshed and updates StreamGenerate Cookie", async () => {
    let capturedStreamCookie = "";
    let refreshedCreds: Record<string, unknown> | null = null;

    const mockFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        const headers = new Headers();
        headers.set("Content-Type", "text/html");
        headers.append(
          "Set-Cookie",
          "__Secure-1PSIDTS=rotated-ts-from-bootstrap; Path=/; Domain=.google.com"
        );
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers,
        });
      }

      if (url.includes("StreamGenerate")) {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedStreamCookie = headers?.Cookie || headers?.cookie || "";
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }

      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "Test bootstrap cookie rotation" }],
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=orig-sid; __Secure-1PSIDTS=old-ts",
        providerSpecificData: { pollIntervalMs: 5 },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
      onCredentialsRefreshed: async (creds) => {
        refreshedCreds = creds;
      },
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.ok(
      refreshedCreds,
      "onCredentialsRefreshed must be called when bootstrap rotates cookies"
    );
    assert.ok(
      typeof refreshedCreds.apiKey === "string" &&
        refreshedCreds.apiKey.includes("__Secure-1PSIDTS=rotated-ts-from-bootstrap"),
      "refreshed apiKey must contain rotated __Secure-1PSIDTS from bootstrap"
    );
    assert.equal(
      refreshedCreds.expectedApiKey,
      "__Secure-1PSID=orig-sid; __Secure-1PSIDTS=old-ts",
      "expectedApiKey must be passed for optimistic concurrency control (CAS)"
    );
    assert.ok(
      capturedStreamCookie.includes("__Secure-1PSIDTS=rotated-ts-from-bootstrap"),
      "StreamGenerate request must use the fresh rotated cookie"
    );
  });

  it("resolves static session tokens from credentials.providerSpecificData and skips session bootstrap", async () => {
    const urlsCalled: string[] = [];
    let streamBodyCaptured = "";

    const mockFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urlsCalled.push(url);

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        streamBodyCaptured = typeof init?.body === "string" ? init.body : "";
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Static token test" }], stream: false },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: {
          atToken: "static-at-token-123",
          fSid: "static-fsid-456",
          pollIntervalMs: 5,
        },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.ok(
      !urlsCalled.some((u) => u.includes("/app")),
      "Must skip /app bootstrap when static session tokens are provided"
    );
    const streamUrl = urlsCalled.find((u) => u.includes("StreamGenerate"));
    assert.ok(streamUrl, "Must call StreamGenerate");
    assert.ok(
      streamUrl.includes("f.sid=static-fsid-456"),
      "StreamGenerate URL must use static fSid"
    );
    assert.ok(
      streamUrl.includes("bl=boq_assistant-bard-web-server_20260907.07_p0"),
      "StreamGenerate URL must use default buildLabel when omitted"
    );
    assert.ok(
      streamBodyCaptured.includes("at=static-at-token-123"),
      "StreamGenerate body must use static atToken"
    );
  });

  it("resolves static session tokens using alias keys (at, fsid, bl) and from input.connection.providerSpecificData", async () => {
    const urlsCalled: string[] = [];

    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urlsCalled.push(url);

      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Alias token test" }], stream: false },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
      },
      connection: {
        providerSpecificData: {
          at: "alias-at-token",
          fsid: "alias-fsid",
          bl: "custom-build-label-999",
          pollIntervalMs: 5,
        },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.ok(
      !urlsCalled.some((u) => u.includes("/app")),
      "Must skip /app bootstrap when static session tokens are provided via connection"
    );
    const streamUrl = urlsCalled.find((u) => u.includes("StreamGenerate"));
    assert.ok(streamUrl, "Must call StreamGenerate");
    assert.ok(streamUrl.includes("f.sid=alias-fsid"), "StreamGenerate URL must use alias fsid");
    assert.ok(
      streamUrl.includes("bl=custom-build-label-999"),
      "StreamGenerate URL must use alias bl"
    );
  });

  it("falls back to bootstrap if providerSpecificData has incomplete static tokens (only atToken)", async () => {
    let appFetched = false;

    const mockFetch = mock.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        appFetched = true;
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(fixture.streamGenerateInitialResponse, { status: 200 });
      }
      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "Incomplete token test" }], stream: false },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: {
          atToken: "only-at-token",
          pollIntervalMs: 5,
        },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.ok(appFetched, "Must proceed with /app bootstrap when static tokens are incomplete");
  });

  describe("resolveStaticSessionTokens", () => {
    it("returns null when providerSpecificData is undefined or empty", () => {
      assert.equal(resolveStaticSessionTokens(), null);
      assert.equal(resolveStaticSessionTokens(null, null), null);
      assert.equal(resolveStaticSessionTokens({}, {}), null);
    });

    it("returns null when atToken or fSid is missing or empty string", () => {
      assert.equal(resolveStaticSessionTokens({ atToken: "   ", fSid: "valid-fsid" }), null);
      assert.equal(resolveStaticSessionTokens({ atToken: "valid-at", fSid: "" }), null);
      assert.equal(
        resolveStaticSessionTokens({ atToken: 123 as unknown as string, fSid: "valid" }),
        null
      );
    });

    it("resolves canonical atToken and fSid with default buildLabel", () => {
      const tokens = resolveStaticSessionTokens({
        atToken: "my-at-token",
        fSid: "my-fsid",
      });
      assert.deepEqual(tokens, {
        atToken: "my-at-token",
        fSid: "my-fsid",
        buildLabel: DEFAULT_GEMINI_WEB_BUILD_LABEL,
      });
    });

    it("resolves custom buildLabel or bl when provided", () => {
      const withBuildLabel = resolveStaticSessionTokens({
        atToken: "my-at",
        fSid: "my-fsid",
        buildLabel: "custom-build-label-1",
      });
      assert.equal(withBuildLabel?.buildLabel, "custom-build-label-1");

      const withBl = resolveStaticSessionTokens({
        at: "my-at",
        fsid: "my-fsid",
        bl: "custom-bl-2",
      });
      assert.equal(withBl?.buildLabel, "custom-bl-2");
    });

    it("resolves tokens across credentials and connection objects", () => {
      const tokens = resolveStaticSessionTokens(
        { at: "at-from-credentials" },
        { fsid: "fsid-from-connection", bl: "bl-from-connection" }
      );
      assert.deepEqual(tokens, {
        atToken: "at-from-credentials",
        fSid: "fsid-from-connection",
        buildLabel: "bl-from-connection",
      });
    });
  });

  describe("Direct HTTP Session Rotation CAS Persistence", () => {
    it("updateProviderConnectionCas succeeds when expectedApiKey matches, and rejects update when expectedApiKey mismatches", async () => {
      const { createProviderConnection, deleteProviderConnection, getProviderConnectionById } =
        await import("../../src/lib/db/providers.ts");
      const created = await createProviderConnection({
        provider: "gemini-web",
        apiKey: "__Secure-1PSID=current-valid-key",
      });
      assert.ok(created?.id);
      const connId = created.id as string;

      try {
        // Successful CAS update with matching expectedApiKey
        const successResult = await updateProviderConnectionCas(
          connId,
          { apiKey: "__Secure-1PSID=current-valid-key; __Secure-1PSIDTS=rotated-ts" },
          "__Secure-1PSID=current-valid-key"
        );
        assert.equal(successResult.updated, true);
        assert.equal(
          successResult.connection?.apiKey,
          "__Secure-1PSID=current-valid-key; __Secure-1PSIDTS=rotated-ts"
        );

        // Stale CAS update with outdated expectedApiKey (operator modified apiKey concurrently)
        const staleResult = await updateProviderConnectionCas(
          connId,
          { apiKey: "__Secure-1PSID=stale-key; __Secure-1PSIDTS=stale-ts" },
          "__Secure-1PSID=current-valid-key" // Stale expectation!
        );
        assert.equal(staleResult.updated, false);
        assert.equal(staleResult.connection, null);

        // Verify stored key in DB was not clobbered
        const currentInDb = await getProviderConnectionById(connId);
        assert.equal(
          currentInDb?.apiKey,
          "__Secure-1PSID=current-valid-key; __Secure-1PSIDTS=rotated-ts"
        );
      } finally {
        await deleteProviderConnection(connId);
      }
    });
  });
});
