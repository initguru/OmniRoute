import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GeminiWebExecutor,
  clearGeminiWebSessionCache,
  isDeepThinkModel,
} from "../../open-sse/executors/gemini-web.ts";
import { GEMINI_DEEP_THINK_MODEL_ID } from "../../open-sse/executors/gemini-web/directProtocol.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/deep-think-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const TERMINAL_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_terminal_command",
      description: "Runs a shell command on host machine",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Reads a local file from disk",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to file" },
        },
        required: ["path"],
      },
    },
  },
];

function makeStreamGenerateChunk(text: string): string {
  const inner = new Array(80).fill(null);
  inner[4] = [[null, [text]]];
  return `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
}

function makeStreamGenerateRaw(text: string): string {
  return `)]}'\n10\n${makeStreamGenerateChunk(text)}`;
}

interface FakePlaywrightResponse {
  url: () => string;
  text: () => Promise<string>;
}

type FakeResponseHandler = (resp: FakePlaywrightResponse) => Promise<void>;

async function withMockedGeminiBrowser<T>(
  responseText: string,
  fn: (typedPrompt: { value: string }) => Promise<T>
): Promise<T> {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const typedPrompt = { value: "" };

  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => {
        let respHandler: FakeResponseHandler | null = null;
        const page = {
          on: (event: string, cb: FakeResponseHandler) => {
            if (event === "response") respHandler = cb;
          },
          goto: async () => {},
          waitForTimeout: async () => {},
          waitForSelector: async () => ({ click: async () => {} }),
          locator: (selector: string) => {
            if (selector.includes("rich-textarea") || selector.includes("textarea")) {
              return {
                first: () => ({
                  count: async () => 1,
                  fill: async (text: string) => {
                    typedPrompt.value = text;
                  },
                }),
              };
            }
            return {
              first: () => ({
                count: async () => 0,
                click: async () => {},
              }),
            };
          },
          keyboard: {
            type: async (text: string) => {
              typedPrompt.value = text;
            },
            press: async () => {
              if (respHandler) {
                await respHandler({
                  url: () => "https://gemini.google.com/_/BardChatUi/data/.../StreamGenerate?x",
                  text: async () => makeStreamGenerateRaw(responseText),
                });
              }
            },
          },
        };
        return page;
      },
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    return await fn(typedPrompt);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
}

describe("GeminiWebExecutor Context Purifier & Tool Bypass for Deep Think", () => {
  beforeEach(() => {
    clearGeminiWebSessionCache();
  });

  it("isDeepThinkModel correctly classifies Deep Think model identifiers", () => {
    assert.equal(isDeepThinkModel("gemini-deep-think"), true);
    assert.equal(isDeepThinkModel(GEMINI_DEEP_THINK_MODEL_ID), true);
    assert.equal(isDeepThinkModel("gweb/gemini-deep-think"), false); // modelId in execute has prefix stripped
    assert.equal(isDeepThinkModel("gemini-3.1-pro"), false);
    assert.equal(isDeepThinkModel("gemini-2.5-pro"), false);
  });

  it("bypasses terminal tool schemas and purifies context for gemini-deep-think", async () => {
    let capturedPromptSent = "";

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("StreamGenerate")) {
        const bodyStr = typeof init?.body === "string" ? init.body : "";
        const params = new URLSearchParams(bodyStr);
        const fReq = params.get("f.req");
        if (fReq) {
          try {
            const outer = JSON.parse(fReq);
            const inner = JSON.parse(outer[1]);
            capturedPromptSent = inner[0][0];
          } catch {
            capturedPromptSent = bodyStr;
          }
        }
        return new Response(fixture.streamGenerateInitialResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      if (url.includes("batchexecute")) {
        return new Response(fixture.pollCompletedResponse, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    // 65KB SessionStart hook + terminal boilerplate noise
    const hookPadding = "x-anthropic-billing-header: cc-uuid-random-entry\n".repeat(1500);
    const sessionStartHook = `
You are Claude Code, Anthropic's official CLI for Claude.
SessionStart hook additional context:
<EXTREMELY_IMPORTANT>
You have superpowers. Follow SDD boundaries strictly.
</EXTREMELY_IMPORTANT>
# Mandatory Parent Edit Barrier (Zero Direct Source Edit Policy)
${hookPadding}
`;

    const userMessageContent = `
<system-reminder>
Contents of semiconductor_spec.md:
# 반도체 포토 공정 규격
EUV 노광 공정에서 오버레이(Overlay) 마진은 1.2nm 이하로 유지되어야 합니다.
</system-reminder>

다음은 반도체 포토 공정 오버레이 마진 분석 질문입니다. 주요 결함 원인을 상세히 설명해주세요.
`;

    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [
          { role: "system", content: sessionStartHook },
          { role: "user", content: userMessageContent },
        ],
        tools: TERMINAL_TOOLS,
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: {
          atToken: "test-at",
          fSid: "test-fsid",
          pollIntervalMs: 5,
        },
      },
      signal: AbortSignal.timeout(10000),
      log: null,
      fetch: mockFetch,
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);

    // Prompt sent to StreamGenerate MUST contain user question & attached doc
    assert.ok(
      capturedPromptSent.includes("다음은 반도체 포토 공정 오버레이 마진 분석 질문입니다"),
      "Must contain user question"
    );
    assert.ok(
      capturedPromptSent.includes("반도체 포토 공정 규격") ||
        capturedPromptSent.includes("EUV 노광 공정"),
      "Must preserve extracted semiconductor spec document"
    );

    // Prompt sent MUST NOT contain tool schemas
    assert.ok(!capturedPromptSent.includes("<tool>"), "Must not contain <tool> schema tags");
    assert.ok(
      !capturedPromptSent.includes("run_terminal_command"),
      "Must not contain terminal command tool name"
    );
    assert.ok(!capturedPromptSent.includes("read_file"), "Must not contain read_file tool name");
    assert.ok(
      !capturedPromptSent.includes("Runs a shell command on host machine"),
      "Must not contain tool description"
    );

    // Prompt sent MUST NOT contain terminal harness boilerplate
    assert.ok(
      !capturedPromptSent.includes("SessionStart hook"),
      "Must not contain SessionStart hook"
    );
    assert.ok(!capturedPromptSent.includes("superpowers"), "Must not contain superpowers");
    assert.ok(
      !capturedPromptSent.includes("Zero Direct Source Edit Policy"),
      "Must not contain Parent Edit Barrier"
    );
    assert.ok(
      !capturedPromptSent.includes("x-anthropic-billing-header"),
      "Must not contain billing header"
    );
  });

  it("legacy model (gemini-3.1-pro) with tools still runs prepareToolMessages and serializes tool schemas", async () => {
    const responseText =
      '<tool>{"name":"run_terminal_command","arguments":{"command":"ls -la"}}</tool>';

    await withMockedGeminiBrowser(responseText, async (typedPrompt) => {
      const executor = new GeminiWebExecutor();
      const result = await executor.execute({
        model: "gemini-3.1-pro",
        body: {
          messages: [{ role: "user", content: "list files in current directory" }],
          tools: TERMINAL_TOOLS,
          stream: false,
        },
        stream: false,
        credentials: { apiKey: "__Secure-1PSID=test-sid" },
        signal: AbortSignal.timeout(10000),
        log: null,
      } as unknown as ExecuteInput);

      assert.equal(result.response.status, 200);

      // Legacy model MUST still serialize tool schemas into the prompt
      assert.ok(
        typedPrompt.value.includes("run_terminal_command"),
        "Legacy model prompt must include tool schema for run_terminal_command"
      );
      assert.ok(
        typedPrompt.value.includes("read_file"),
        "Legacy model prompt must include tool schema for read_file"
      );
      assert.ok(
        typedPrompt.value.includes("list files in current directory"),
        "Legacy model prompt must include user message"
      );
    });
  });
});
