import test from "node:test";
import assert from "node:assert/strict";

const { buildGeminiPrompt, buildGeminiToolPrompt, GeminiWebExecutor } =
  await import("../../open-sse/executors/gemini-web.ts");
const { GEMINI_DEEP_THINK_TIMEOUT_CODE } = await import("../../open-sse/config/constants.ts");

type MockStreamResponse = {
  url: () => string;
  status: () => number;
  text: () => Promise<string>;
};

type MockResponseListener = (resp: MockStreamResponse) => Promise<void> | void;

interface ErrorResponseBody {
  error: {
    message: string;
    type?: string;
    code?: string;
  };
  choices?: Array<{
    message: {
      content: string;
    };
  }>;
  model?: string;
}

function makeStreamChunk(text: string): string {
  const inner = new Array(80).fill(null);
  inner[4] = [[null, [text]]];
  return `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
}

function createMockPage(
  options: {
    streamResponseBody?: string;
    streamResponseStatus?: number;
    modePickerAriaLabel?: string;
    proDisabled?: boolean;
    deepThinkDisabled?: boolean;
    deepThinkActive?: boolean;
    composerExists?: boolean;
    timeoutError?: boolean;
  } = {}
) {
  const {
    streamResponseBody = `)]}'\n123\n${makeStreamChunk("Deep Think Result")}`,
    streamResponseStatus = 200,
    modePickerAriaLabel = "Open mode picker, currently 3.1 Pro",
    proDisabled = false,
    deepThinkDisabled = false,
    deepThinkActive = true,
    composerExists = true,
    timeoutError = false,
  } = options;

  let composerText = "";
  const listeners = new Set<MockResponseListener>();

  const triggerResponse = async () => {
    if (timeoutError) return;
    const resp: MockStreamResponse = {
      url: () =>
        "https://gemini.google.com/app/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
      status: () => streamResponseStatus,
      text: async () => streamResponseBody,
    };
    for (const l of Array.from(listeners)) {
      await l(resp);
    }
  };

  return {
    on(event: string, l: MockResponseListener) {
      if (event === "response") listeners.add(l);
    },
    off(event: string, l: MockResponseListener) {
      if (event === "response") listeners.delete(l);
    },
    removeListener(event: string, l: MockResponseListener) {
      if (event === "response") listeners.delete(l);
    },
    goto: async () => {},
    waitForTimeout: async () => {},
    locator(selector: string) {
      if (selector.includes("aria-label*='Open mode picker, currently '")) {
        return {
          first: () => this.locator(selector),
          count: async () => 1,
          getAttribute: async (attr: string) =>
            attr === "aria-label" ? modePickerAriaLabel : null,
          click: async () => {},
        };
      }
      if (selector.includes("3.1 Pro") || selector.includes("bard-mode-option-9d8ca3786ebdfbea")) {
        return {
          first: () => this.locator(selector),
          count: async () => 1,
          getAttribute: async (attr: string) =>
            attr === "aria-disabled" ? (proDisabled ? "true" : "false") : null,
          click: async () => {},
        };
      }
      if (selector.includes("Deep Think")) {
        return {
          first: () => this.locator(selector),
          count: async () => 1,
          getAttribute: async (attr: string) => {
            if (attr === "aria-disabled") return deepThinkDisabled ? "true" : "false";
            if (attr === "data-active" || attr === "aria-checked")
              return deepThinkActive ? "true" : "false";
            return null;
          },
          click: async () => {},
        };
      }
      if (selector.includes(".ql-editor") || selector.includes("contenteditable")) {
        return {
          first: () => this.locator(selector),
          count: async () => (composerExists ? 1 : 0),
          fill: async (val: string) => {
            composerText = val;
          },
          innerText: async () => composerText,
          textContent: async () => composerText,
          inputValue: async () => composerText,
          press: async (key: string) => {
            if (key === "Enter") void triggerResponse();
          },
        };
      }
      return {
        first: () => this.locator(selector),
        count: async () => 0,
        getAttribute: async () => null,
        click: async () => {},
      };
    },
    keyboard: {
      type: async () => {},
      press: async (key: string) => {
        if (key === "Enter") void triggerResponse();
      },
    },
    close: async () => {},
    get composerText() {
      return composerText;
    },
  };
}

test("buildGeminiPrompt extracts text from array content parts in order (Claude Code @file expansions)", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Please review this file:" },
        { type: "text", text: "\n\n// contents of file.ts\nconst x = 1;" },
      ],
    },
  ];

  const result = buildGeminiPrompt(messages);
  assert.equal(result, "Please review this file:\n\n// contents of file.ts\nconst x = 1;");
});

test("buildGeminiPrompt preserves multi-turn conversation with array content parts", () => {
  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: "You are a senior reviewer." }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Here is step 1:" },
        { type: "text", text: " details" },
      ],
    },
    {
      role: "assistant",
      content: "Got it, ready for step 2.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Step 2: " },
        { type: "text", text: "@file contents" },
      ],
    },
  ];

  const result = buildGeminiPrompt(messages);
  assert.ok(result.includes("System:\nYou are a senior reviewer."));
  assert.ok(result.includes("Previous conversation:"));
  assert.ok(result.includes("User: Here is step 1: details"));
  assert.ok(result.includes("Assistant: Got it, ready for step 2."));
  assert.ok(result.includes("Current user message:\nStep 2: @file contents"));
});

test("buildGeminiPrompt returns empty string when content blocks contain only non-text parts", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }],
    },
  ];

  const result = buildGeminiPrompt(messages);
  assert.equal(result, "");
});

test("buildGeminiToolPrompt extracts text from array content parts", () => {
  const messages = [
    {
      role: "system",
      content: "Tool instructions",
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Use tool on " },
        { type: "text", text: "target file" },
      ],
    },
  ];

  const result = buildGeminiToolPrompt(messages);
  assert.equal(result, "Tool instructions\n\nUse tool on target file");
});

test("GeminiWebExecutor.execute runs state machine and fills prompt for gemini-deep-think", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;

  const mockPage = createMockPage();

  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => mockPage,
      cookies: async () => [],
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-deep-think",
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Complex reasoning problem " },
              { type: "text", text: "with @file prompt" },
            ],
          },
        ],
        stream: false,
      },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: { timeoutMs: 120_000 },
      },
      signal: AbortSignal.timeout(10000),
      log: null,
    });

    assert.equal(result.response.status, 200);
    assert.equal(mockPage.composerText, "Complex reasoning problem with @file prompt");

    const json = (await result.response.json()) as ErrorResponseBody;
    assert.equal(json.choices?.[0]?.message?.content, "Deep Think Result");
    assert.equal(json.model, "gemini-deep-think");
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});

test("GeminiWebExecutor.execute maps GeminiWebUiStateError appropriately without leaking stack traces", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;

  // 1. Missing composer (409)
  const mockPageNoComposer = createMockPage({ composerExists: false });
  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => mockPageNoComposer,
      cookies: async () => [],
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    const executor = new GeminiWebExecutor();
    const res409 = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=test-sid" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(res409.response.status, 409);
    const json409 = (await res409.response.json()) as ErrorResponseBody;
    assert.equal(json409.error.code, "gemini_web_ui_contract_mismatch");
    assert.ok(!json409.error.message.includes("at /"));
  } finally {
    playwright.chromium.launch = originalLaunch;
  }

  // 2. Disabled Deep Think (409)
  const mockPageDisabledDt = createMockPage({ deepThinkDisabled: true, deepThinkActive: false });
  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => mockPageDisabledDt,
      cookies: async () => [],
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    const executor = new GeminiWebExecutor();
    const res409 = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=test-sid" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(res409.response.status, 409);
    const json409 = (await res409.response.json()) as ErrorResponseBody;
    assert.equal(json409.error.code, "gemini_deep_think_unavailable");
    assert.ok(!json409.error.message.includes("at /"));
  } finally {
    playwright.chromium.launch = originalLaunch;
  }

  // 3. Timeout error (504)
  const mockPageTimeout = createMockPage({ timeoutError: true });
  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => mockPageTimeout,
      cookies: async () => [],
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    const executor = new GeminiWebExecutor();
    const res504 = await executor.execute({
      model: "gemini-deep-think",
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false,
      credentials: {
        apiKey: "__Secure-1PSID=test-sid",
        providerSpecificData: { timeoutMs: 20 },
      },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(res504.response.status, 504);
    const json504 = (await res504.response.json()) as ErrorResponseBody;
    assert.equal(json504.error.code, GEMINI_DEEP_THINK_TIMEOUT_CODE);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});

test("Legacy models continue through the existing typing path without regression", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;

  let typedText = "";
  const mockPage = {
    on: () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => ({
      click: async () => {},
    }),
    keyboard: {
      type: async (text: string) => {
        typedText = text;
      },
      press: async () => {},
    },
    close: async () => {},
  };

  playwright.chromium.launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => mockPage,
      cookies: async () => [],
    }),
    close: async () => {},
  })) as unknown as typeof playwright.chromium.launch;

  try {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "legacy question" }], stream: false },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=test-sid" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(typedText, "legacy question");
    // Since mock page did not emit StreamGenerate, it returns 502 as expected
    assert.equal(result.response.status, 502);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});
