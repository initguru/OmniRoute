import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GeminiWebExecutor,
  clearGeminiWebSessionCache,
} from "../../open-sse/executors/gemini-web.ts";
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

describe("GeminiWebExecutor Deep Think Early SSE Keepalive (Ping) Streaming", () => {
  beforeEach(() => {
    clearGeminiWebSessionCache();
  });

  it("returns immediate 200 SSE response with keepalive headers when stream is true and envelope is pending", async () => {
    let pollCount = 0;
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
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      if (url.includes("batchexecute") && url.includes("hNvQHb")) {
        pollCount++;
        if (pollCount <= 2) {
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

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "What is the capital of France?" }],
        stream: true,
      },
      stream: true,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid; __Secure-1PSIDTS=test-ts",
        providerSpecificData: { pollIntervalMs: 10 },
      },
      signal: AbortSignal.timeout(10000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    assert.equal(result.response.headers.get("Cache-Control"), "no-cache, no-transform");
    assert.equal(result.response.headers.get("Connection"), "keep-alive");
    assert.equal(result.response.headers.get("X-Accel-Buffering"), "no");

    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    assert.ok(
      streamText.includes(": ping\n\n"),
      "Stream must contain periodic ': ping\\n\\n' comments"
    );
    assert.ok(
      streamText.includes('"content":"Paris"'),
      "Stream must contain final answer content chunk"
    );
    assert.ok(streamText.includes("data: [DONE]\n\n"), "Stream must conclude with data: [DONE]");
    assert.ok(pollCount >= 2, "Must have polled at least twice");
  });

  it("propagates client AbortSignal during pending polling and aborts cleanly", async () => {
    const ac = new AbortController();
    let pollCount = 0;

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
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      if (url.includes("batchexecute") && url.includes("hNvQHb")) {
        pollCount++;
        if (pollCount >= 1) {
          // Trigger abort after first poll
          ac.abort(new Error("Client cancelled"));
        }
        return new Response(fixture.pollPendingResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "Calculate something slow" }],
        stream: true,
      },
      stream: true,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: { pollIntervalMs: 5 },
      },
      signal: ac.signal,
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamText += decoder.decode(value, { stream: true });
      }
    } catch {
      // Reader may throw on abort or cleanly finish
    }

    assert.ok(streamText.includes(": ping\n\n"), "Stream must receive initial ping before abort");
    assert.ok(pollCount <= 3, "Polling must halt shortly after abort");
  });

  it("emits sanitized error chunk and completes when polling times out", async () => {
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
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      if (url.includes("batchexecute") && url.includes("hNvQHb")) {
        return new Response(fixture.pollPendingResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "Trigger timeout" }],
        stream: true,
      },
      stream: true,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: {
          pollIntervalMs: 10,
          timeoutMs: 30, // very short timeout
        },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
      fetch: mockFetch as unknown as typeof fetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    assert.ok(
      streamText.includes("timed out") || streamText.includes("error"),
      "Stream must contain error message on timeout"
    );
    assert.ok(
      !streamText.includes("/Users/") && !streamText.includes("/home/"),
      "Error text must be sanitized"
    );
  });

  it("retains non-streaming behavior when stream is false", async () => {
    let pollCount = 0;
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
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      if (url.includes("batchexecute") && url.includes("hNvQHb")) {
        pollCount++;
        return new Response(fixture.pollCompletedResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [{ role: "user", content: "Non-streaming test" }],
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

    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("Content-Type"), "application/json");
    const json = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(json.choices[0].message.content, "Paris");
    assert.equal(pollCount, 1);
  });
});
