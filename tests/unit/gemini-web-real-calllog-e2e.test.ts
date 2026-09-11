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

// Helper to generate a 65KB SessionStart hook context string
function generate65KbSessionStartHook(): string {
  const boilerplate = `SessionStart hook additional context: <EXTREMELY_IMPORTANT>
You have superpowers.
## Mandatory Parent Edit Barrier (Zero Direct Source Edit Policy)
- As the root/main coordinator, you are STRICTLY PROHIBITED from calling Edit or Write on any codebase implementation.
- All code edits MUST be delegated to a first-level implementer subagent via the Agent tool.
# SDD boundaries:
- Source-file modification is the SDD switch point.
- The root/main coordinator never writes source or test code; its first-level implementer subagents do.
# Delegation & worktree control:
- Nested dispatch is banned. Depth <= 1.
`;
  return boilerplate.repeat(65); // ~65KB
}

// 45 terminal tools simulation
const MOCK_45_TERMINAL_TOOLS = Array.from({ length: 45 }, (_, i) => ({
  type: "function",
  function: {
    name: i === 0 ? "run_terminal_command" : i === 1 ? "read_file" : `tool_${i}`,
    description: `Terminal command tool ${i} to execute tasks on host shell`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
}));

describe("GeminiWebExecutor Real Call Log E2E Integration (1789058479677-a2d70f)", () => {
  beforeEach(() => {
    clearGeminiWebSessionCache();
  });

  it("successfully purifies 65KB terminal hook, bypasses 45 tools, emits SSE keepalive, and delivers core reasoning response", async () => {
    let capturedPromptSent = "";
    let pollCount = 0;

    const mockFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/app")) {
        return new Response(MOCK_HTML_SESSION, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.includes("StreamGenerate")) {
        const bodyStr = typeof init?.body === "string" ? init.body : init?.body?.toString() || "";
        const searchParams = new URLSearchParams(bodyStr);
        const fReq = searchParams.get("f.req");
        if (fReq) {
          try {
            const parsed = JSON.parse(fReq);
            if (Array.isArray(parsed) && parsed[1]) {
              const inner = typeof parsed[1] === "string" ? JSON.parse(parsed[1]) : parsed[1];
              capturedPromptSent = inner?.[0]?.[0] || "";
            } else {
              capturedPromptSent = parsed[0]?.[0] || "";
            }
          } catch {
            capturedPromptSent = fReq;
          }
        }
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
        // Completed response
        return new Response(fixture.pollCompletedResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const userMessageContent = `<system-reminder>
<env>
Working directory: /Users/jihyun.son/github/OmniRoute
Is directory a git repo: Yes
</env>
gitStatus: clean
<total_tokens>15000000 tokens left</total_tokens>
</system-reminder>
다음은 반도체 제조 공정의 수율 분석 및 실시간 모니터링 시스템 아키텍처 사양서입니다. 아키텍처의 완성도와 고가용성 설계를 심층 평가해 주세요.

---
# Semiconductor Manufacturing Architecture Specification
## 1. Overview
High-throughput yield analysis and real-time FDC streaming engine.
Kafka + Flink + ClickHouse architecture for 100k events/sec.
`;

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gweb/gemini-deep-think",
      body: {
        messages: [
          { role: "system", content: generate65KbSessionStartHook() },
          { role: "user", content: userMessageContent },
        ],
        tools: MOCK_45_TERMINAL_TOOLS,
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

    // 1. Response status & headers
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    assert.equal(result.response.headers.get("Connection"), "keep-alive");

    // 2. Stream chunk verification
    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let streamOutput = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamOutput += decoder.decode(value, { stream: true });
    }

    assert.ok(streamOutput.includes(": ping\n\n"), "Must emit keepalive ping comments");
    assert.ok(streamOutput.includes('"content":"Paris"'), "Must include completion text");
    assert.ok(streamOutput.includes("data: [DONE]\n\n"), "Must conclude with data: [DONE]");
    assert.ok(pollCount >= 2, "Must have polled at least twice");

    // 3. Upstream payload inspection (Purifier + Tool Bypass validation)
    assert.ok(
      capturedPromptSent.includes("다음은 반도체 제조 공정의 수율 분석"),
      "Must preserve core user question"
    );
    assert.ok(
      capturedPromptSent.includes("Semiconductor Manufacturing Architecture Specification"),
      "Must preserve attached document"
    );

    // Must NOT contain terminal noise
    assert.ok(
      !capturedPromptSent.includes("SessionStart hook"),
      "Must NOT contain SessionStart hook"
    );
    assert.ok(!capturedPromptSent.includes("superpowers"), "Must NOT contain superpowers");
    assert.ok(
      !capturedPromptSent.includes("Zero Direct Source Edit Policy"),
      "Must NOT contain edit policy"
    );
    assert.ok(!capturedPromptSent.includes("run_terminal_command"), "Must NOT contain tool name");
    assert.ok(!capturedPromptSent.includes("read_file"), "Must NOT contain tool name");
    assert.ok(!capturedPromptSent.includes("<tool>"), "Must NOT contain tool schema tags");
  });
});
