import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GeminiWebExecutor,
  clearGeminiWebSessionCache,
} from "../../open-sse/executors/gemini-web.ts";
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
    const result = await executor.execute({
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
    } as unknown as ExecuteInput);

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
});
