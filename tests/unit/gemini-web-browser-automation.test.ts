import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  runGeminiDeepThinkUiStateMachine,
  GeminiWebUiStateError,
  MODEL_RESPONSE_SELECTOR,
  DEEP_THINK_TOGGLE_SELECTOR,
  isDeepThinkActiveLabel,
  isDeepThinkFailureText,
  formatSyntheticStreamResponse,
} from "../../open-sse/executors/gemini-web/browserAutomation.ts";
import { parseStreamResponse } from "../../open-sse/executors/gemini-web.ts";

interface MockPageOptions {
  initialModePickerAriaLabel?: string;
  initialModePickerText?: string;
  proMenuItemExists?: boolean;
  proMenuItemAriaDisabled?: string;
  proClickUpdatesModePicker?: boolean;
  proClickResultAriaLabel?: string;
  deepThinkExists?: boolean;
  deepThinkAriaDisabled?: string;
  deepThinkInitiallyActive?: boolean;
  deepThinkClickActivates?: boolean;
  deepThinkClickUpdatesModePicker?: boolean;
  composerExists?: boolean;
  composerAcceptsFill?: boolean;
  streamResponseStatus?: number;
  streamResponseBody?: string;
  streamResponseDelayMs?: number;
  streamResponses?: Array<{ status?: number; body: string; delayMs?: number }>;
  neverRespond?: boolean;
  domResponseTexts?: string[];
  domResponseDelayMs?: number;
}

function createMockPage(options: MockPageOptions = {}) {
  const {
    initialModePickerAriaLabel = "Open mode picker, currently Fast",
    initialModePickerText = "Fast",
    proMenuItemExists = true,
    proMenuItemAriaDisabled = "false",
    proClickUpdatesModePicker = true,
    proClickResultAriaLabel,
    deepThinkExists = true,
    deepThinkAriaDisabled = "false",
    deepThinkInitiallyActive = false,
    deepThinkClickActivates = true,
    deepThinkClickUpdatesModePicker = false,
    composerExists = true,
    composerAcceptsFill = true,
    streamResponseStatus = 200,
    streamResponseBody = ')]}\'\n[["wrb.fr",null,"[[null,null,null,null,[null,null,null,null,[\\"Deep Think Result\\"]]]]"]]',
    streamResponseDelayMs = 5,
    streamResponses,
    neverRespond = false,
    domResponseTexts = [],
    domResponseDelayMs = 0,
  } = options;

  let currentDomTexts: string[] = [...domResponseTexts];
  if (domResponseDelayMs > 0 && domResponseTexts.length > 0) {
    currentDomTexts = [];
    setTimeout(() => {
      currentDomTexts = [...domResponseTexts];
    }, domResponseDelayMs);
  }

  let currentModePickerAriaLabel = initialModePickerAriaLabel;
  let currentModePickerText = initialModePickerText;
  let isDeepThinkActive = deepThinkInitiallyActive;
  let composerText = "";
  let promptInjected = false;
  let promptSubmitted = false;

  type ResponseListener = (resp: {
    url: () => string;
    status: () => number;
    text: () => Promise<string>;
  }) => Promise<void> | void;

  const responseListeners = new Set<ResponseListener>();

  const triggerStreamResponse = async () => {
    if (neverRespond) return;
    if (streamResponses && streamResponses.length > 0) {
      for (const item of streamResponses) {
        if (item.delayMs && item.delayMs > 0) {
          await new Promise((r) => setTimeout(r, item.delayMs));
        }
        const mockResp = {
          url: () =>
            "https://gemini.google.com/app/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
          status: () => item.status ?? 200,
          text: async () => item.body,
        };
        for (const listener of Array.from(responseListeners)) {
          await listener(mockResp);
        }
      }
      return;
    }
    if (streamResponseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, streamResponseDelayMs));
    }
    const mockResp = {
      url: () =>
        "https://gemini.google.com/app/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
      status: () => streamResponseStatus,
      text: async () => streamResponseBody,
    };
    for (const listener of Array.from(responseListeners)) {
      await listener(mockResp);
    }
  };

  const page = {
    on(event: string, listener: ResponseListener) {
      if (event === "response") {
        responseListeners.add(listener);
      }
    },
    off(event: string, listener: ResponseListener) {
      if (event === "response") {
        responseListeners.delete(listener);
      }
    },
    removeListener(event: string, listener: ResponseListener) {
      if (event === "response") {
        responseListeners.delete(listener);
      }
    },
    waitForTimeout: async (_ms: number) => {},
    locator(selector: string) {
      // Mode picker trigger
      if (selector.includes("aria-label*='Open mode picker'")) {
        return {
          first: () => this.locator(selector),
          count: async () => 1,
          getAttribute: async (attr: string) => {
            if (attr === "aria-label") return currentModePickerAriaLabel;
            return null;
          },
          innerText: async () => currentModePickerText,
          textContent: async () => currentModePickerText,
          click: async () => {},
        };
      }

      // Pro menu item
      if (
        selector.includes("bard-mode-option-9d8ca3786ebdfbea") ||
        selector.includes("3.1 Pro") ||
        selector.includes("Pro")
      ) {
        return {
          first: () => this.locator(selector),
          count: async () => (proMenuItemExists ? 1 : 0),
          getAttribute: async (attr: string) => {
            if (attr === "aria-disabled") return proMenuItemAriaDisabled;
            return null;
          },
          click: async () => {
            if (proClickUpdatesModePicker) {
              currentModePickerAriaLabel =
                proClickResultAriaLabel ?? "Open mode picker, currently 3.1 Pro";
            }
          },
        };
      }

      // Deep Think toggle
      if (selector.includes("Deep Think")) {
        return {
          first: () => this.locator(selector),
          count: async () => (deepThinkExists ? 1 : 0),
          getAttribute: async (attr: string) => {
            if (attr === "aria-disabled") return deepThinkAriaDisabled;
            if (attr === "data-active") return isDeepThinkActive ? "true" : "false";
            if (attr === "aria-checked") return isDeepThinkActive ? "true" : "false";
            return null;
          },
          click: async () => {
            if (deepThinkClickActivates) {
              isDeepThinkActive = true;
              if (deepThinkClickUpdatesModePicker) {
                currentModePickerAriaLabel = "Open mode picker, currently Pro Deep Think";
                currentModePickerText = "Pro\nDeep Think";
              }
            }
          },
        };
      }

      // Composer
      if (selector.includes(".ql-editor") || selector.includes("contenteditable")) {
        return {
          first: () => this.locator(selector),
          count: async () => (composerExists ? 1 : 0),
          fill: async (val: string) => {
            if (composerAcceptsFill) {
              composerText = val;
              promptInjected = true;
            }
          },
          innerText: async () => composerText,
          textContent: async () => composerText,
          inputValue: async () => composerText,
          press: async (key: string) => {
            if (key === "Enter") {
              promptSubmitted = true;
              void triggerStreamResponse();
            }
          },
        };
      }

      // Model response turn
      if (
        selector.includes("model-response-text") ||
        selector.includes("message-content") ||
        selector.includes("model-turn")
      ) {
        return {
          first: () => ({
            innerText: async () => currentDomTexts[0] ?? "",
            textContent: async () => currentDomTexts[0] ?? "",
          }),
          count: async () => currentDomTexts.length,
          allInnerTexts: async () => [...currentDomTexts],
          allTextContents: async () => [...currentDomTexts],
          all: async () =>
            currentDomTexts.map((txt) => ({
              innerText: async () => txt,
              textContent: async () => txt,
            })),
          nth: (i: number) => ({
            innerText: async () => currentDomTexts[i] ?? "",
            textContent: async () => currentDomTexts[i] ?? "",
          }),
        };
      }

      // Generic fallback
      return {
        first: () => this.locator(selector),
        count: async () => 0,
        getAttribute: async () => null,
        click: async () => {},
        fill: async () => {},
      };
    },
    keyboard: {
      press: async (key: string) => {
        if (key === "Enter") {
          promptSubmitted = true;
          void triggerStreamResponse();
        }
      },
    },
    get state() {
      return {
        get promptInjected() {
          return promptInjected;
        },
        get promptSubmitted() {
          return promptSubmitted;
        },
        get responseListenersCount() {
          return responseListeners.size;
        },
        get isDeepThinkActive() {
          return isDeepThinkActive;
        },
        get currentModePickerAriaLabel() {
          return currentModePickerAriaLabel;
        },
      };
    },
  };

  return page;
}

test("GeminiWebUiStateError contract", () => {
  const err = new GeminiWebUiStateError("gemini_deep_think_unavailable", "Option missing", 409);
  assert.equal(err.name, "GeminiWebUiStateError");
  assert.equal(err.kind, "gemini_deep_think_unavailable");
  assert.equal(err.status, 409);
  assert.equal(err.message, "Option missing");
});

test("Normal happy path: Pro selection -> Deep Think -> prompt injected -> Enter -> response captured", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Fast",
    proMenuItemExists: true,
    proMenuItemAriaDisabled: "false",
    proClickUpdatesModePicker: true,
    deepThinkExists: true,
    deepThinkAriaDisabled: "false",
    deepThinkInitiallyActive: false,
    deepThinkClickActivates: true,
    composerExists: true,
  });

  const prompt = "Solve this complex proof using deep reasoning";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Deep Think Result/);
  assert.equal(mockPage.state.promptInjected, true);
  assert.equal(mockPage.state.promptSubmitted, true);
  assert.equal(mockPage.state.isDeepThinkActive, true);
  assert.equal(mockPage.state.currentModePickerAriaLabel, "Open mode picker, currently 3.1 Pro");
  // Listener cleaned up
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("Normal happy path when Pro is already selected: verifies Pro -> Deep Think -> prompt injected", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
  });

  const prompt = "Hello already pro";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Deep Think Result/);
  assert.equal(mockPage.state.promptInjected, true);
  assert.equal(mockPage.state.promptSubmitted, true);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When Pro menuitem is aria-disabled='true', throws gemini_deep_think_unavailable (409) and never injects prompt", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Fast",
    proMenuItemExists: true,
    proMenuItemAriaDisabled: "true",
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "Secret sensitive prompt that must never be sent",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_deep_think_unavailable");
      assert.equal(err.status, 409);
      assert.match(err.message, /3\.1 Pro/i);
      return true;
    }
  );

  assert.equal(mockPage.state.promptInjected, false);
  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When Pro menuitem is missing, throws gemini_deep_think_unavailable (409) and never injects prompt", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Fast",
    proMenuItemExists: false,
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "Secret sensitive prompt",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_deep_think_unavailable");
      assert.equal(err.status, 409);
      return true;
    }
  );

  assert.equal(mockPage.state.promptInjected, false);
  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When Deep Think option is missing, throws gemini_deep_think_unavailable (409) and never submits prompt", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: false,
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "Prompt must not be submitted without deep think",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_deep_think_unavailable");
      assert.equal(err.status, 409);
      assert.match(err.message, /deep think/i);
      return true;
    }
  );

  assert.equal(mockPage.state.promptInjected, false);
  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When Deep Think option is disabled (aria-disabled='true'), throws gemini_deep_think_unavailable (409) and never submits prompt", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: true,
    deepThinkAriaDisabled: "true",
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "Prompt must not be submitted",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_deep_think_unavailable");
      assert.equal(err.status, 409);
      return true;
    }
  );

  assert.equal(mockPage.state.promptInjected, false);
  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When Pro selection postcondition fails (mode picker button aria-label does not include 3.1 Pro), throws gemini_web_ui_contract_mismatch (409)", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Fast",
    proMenuItemExists: true,
    proMenuItemAriaDisabled: "false",
    proClickUpdatesModePicker: false, // Click does not update mode picker label!
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "Do not submit on postcondition mismatch",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_web_ui_contract_mismatch");
      assert.equal(err.status, 409);
      assert.match(err.message, /postcondition/i);
      return true;
    }
  );

  assert.equal(mockPage.state.promptInjected, false);
  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When composer is missing, throws gemini_web_ui_contract_mismatch (409)", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
    composerExists: false,
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "test",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_web_ui_contract_mismatch");
      assert.equal(err.status, 409);
      return true;
    }
  );

  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When composer fill fails to populate text, throws gemini_web_ui_contract_mismatch (409)", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
    composerExists: true,
    composerAcceptsFill: false, // Fill does not set text!
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "test fill failure",
        signal: new AbortController().signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_web_ui_contract_mismatch");
      assert.equal(err.status, 409);
      assert.match(err.message, /empty/i);
      return true;
    }
  );

  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When timeout occurs, cleans up response listener and throws timeout error", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
    neverRespond: true, // Will not respond
  });

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "this will time out",
        signal: new AbortController().signal,
        timeoutMs: 40,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/i);
      return true;
    }
  );

  // Listener MUST be cleaned up even on timeout!
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When signal is aborted, aborts cleanly and removes listener", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently 3.1 Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
    neverRespond: true,
  });

  const abortController = new AbortController();

  const promise = runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt: "this will be aborted",
    signal: abortController.signal,
    timeoutMs: 5000,
  });

  // Abort after a brief delay
  setTimeout(() => {
    abortController.abort(new Error("Request aborted by client"));
  }, 20);

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /aborted/i);
    return true;
  });

  // Listener MUST be cleaned up on abort!
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("When signal is already aborted before start, fails immediately and cleans up", async () => {
  const mockPage = createMockPage();
  const abortController = new AbortController();
  abortController.abort(new Error("Pre-aborted"));

  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "pre-aborted prompt",
        signal: abortController.signal,
        timeoutMs: 5000,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /aborted/i);
      return true;
    }
  );

  assert.equal(mockPage.state.promptInjected, false);
  assert.equal(mockPage.state.promptSubmitted, false);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("Google AI Ultra mode picker: recognizes 'Open mode picker, currently Pro' as Pro selected", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro",
    initialModePickerText: "Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
  });

  const prompt = "Prompt on Ultra with currently Pro";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Deep Think Result/);
  assert.equal(mockPage.state.promptInjected, true);
  assert.equal(mockPage.state.promptSubmitted, true);
});

test("Google AI Ultra mode picker: recognizes 'Open mode picker, currently Pro Deep Think' as Pro and Deep Think active", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    deepThinkExists: false, // Menu item should not even need to be queried because button already shows Deep Think active!
  });

  const prompt = "Prompt on Ultra with currently Pro Deep Think";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Deep Think Result/);
  assert.equal(mockPage.state.promptInjected, true);
  assert.equal(mockPage.state.promptSubmitted, true);
});

test("Google AI Ultra postcondition: when clicking Pro updates aria-label to 'Open mode picker, currently Pro', postcondition succeeds", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Fast",
    initialModePickerText: "Fast",
    proMenuItemExists: true,
    proClickUpdatesModePicker: true,
    proClickResultAriaLabel: "Open mode picker, currently Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: true,
  });

  const prompt = "Test Ultra Pro postcondition";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Deep Think Result/);
  assert.equal(mockPage.state.promptInjected, true);
  assert.equal(mockPage.state.promptSubmitted, true);
});

test("Deep Think activation: clicking Deep Think updates mode picker label and verifies postcondition", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro",
    initialModePickerText: "Pro",
    deepThinkExists: true,
    deepThinkInitiallyActive: false,
    deepThinkClickActivates: true,
    deepThinkClickUpdatesModePicker: true,
  });

  const prompt = "Activating Deep Think dynamically";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Deep Think Result/);
  assert.equal(mockPage.state.isDeepThinkActive, true);
  assert.equal(
    mockPage.state.currentModePickerAriaLabel,
    "Open mode picker, currently Pro Deep Think"
  );
});

test("Deep Think intermediate placeholder: ignores 'Responses with Deep Think can take some time' / agentic_processing_chip frame and resolves with subsequent final StreamGenerate response", async () => {
  const placeholderBody =
    ')]}\'\n[["wrb.fr",null,"[[null,null,null,null,[null,null,null,null,[\\"I\'m on it. Responses with Deep Think can take some time, so check back in a bit.\\\\n\\\\n http://googleusercontent.com/agentic_processing_chip/0\\"]]]]"]]';
  const finalBody =
    ')]}\'\n[["wrb.fr",null,"[[null,null,null,null,[null,null,null,null,[\\"Verified Final Deep Think Answer\\"]]]]"]]';

  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    streamResponses: [
      { status: 200, body: placeholderBody, delayMs: 5 },
      { status: 200, body: finalBody, delayMs: 25 },
    ],
  });

  const prompt = "Proof that triggers parallel deep thinking";
  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt,
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  assert.match(rawResponse, /Verified Final Deep Think Answer/);
  assert.doesNotMatch(rawResponse, /agentic_processing_chip/);
  assert.equal(mockPage.state.promptInjected, true);
  assert.equal(mockPage.state.promptSubmitted, true);
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("Task 1: isDeepThinkActiveLabel recognizes 'Extended thinking'", () => {
  assert.equal(isDeepThinkActiveLabel("Open mode picker, currently Extended thinking"), true);
  assert.equal(isDeepThinkActiveLabel("", "Extended thinking"), true);
  assert.equal(isDeepThinkActiveLabel("Deep Think active"), true);
  assert.equal(isDeepThinkActiveLabel("Fast mode"), false);
});

test("Task 1: isDeepThinkFailureText recognizes generation failure messages", () => {
  assert.equal(
    isDeepThinkFailureText("Gemini wasn't able to finish thinking. Please try again."),
    true
  );
  assert.equal(
    isDeepThinkFailureText("I was not able to finish thinking due to an internal error."),
    true
  );
  assert.equal(
    isDeepThinkFailureText("Gemini ran into an issue and wasn't able to finish this response."),
    true
  );
  assert.equal(
    isDeepThinkFailureText("This attempt didn't count against your Deep Think limit."),
    true
  );
  assert.equal(isDeepThinkFailureText("Here is the answer to your mathematical proof."), false);
});

test("Task 1: MODEL_RESPONSE_SELECTOR and DEEP_THINK_TOGGLE_SELECTOR definitions", () => {
  assert.ok(MODEL_RESPONSE_SELECTOR.includes(".model-response-text"));
  assert.ok(MODEL_RESPONSE_SELECTOR.includes("message-content"));
  assert.ok(DEEP_THINK_TOGGLE_SELECTOR.includes("Extended thinking"));
});

test("Task 1: formatSyntheticStreamResponse formats valid parseable stream output", () => {
  const text = "Synthetic DOM response text";
  const formatted = formatSyntheticStreamResponse(text);
  assert.ok(formatted.startsWith(")]}'\n"));
  assert.ok(formatted.includes("wrb.fr"));

  const parsed = parseStreamResponse(formatted);
  assert.equal(parsed, text);

  // Escapes quotes and newlines
  const complexText = 'Line 1\n"Line 2" with special chars & <tags>';
  const complexFormatted = formatSyntheticStreamResponse(complexText);
  assert.equal(parseStreamResponse(complexFormatted), complexText);
});

test("Task 2: DOM failure rejection occurs within < 1 second instead of waiting for timeout", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    neverRespond: true, // Network will never respond
    domResponseTexts: [
      "Gemini wasn't able to finish thinking. This attempt didn't count against your Deep Think limit.",
    ],
    domResponseDelayMs: 20,
  });

  const start = Date.now();
  await assert.rejects(
    async () => {
      await runGeminiDeepThinkUiStateMachine({
        page: mockPage as unknown as Page,
        prompt: "Complex prompt that fails in Deep Think generation",
        signal: new AbortController().signal,
        timeoutMs: 10000, // 10s timeout - must fail in < 1s via DOM polling!
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof GeminiWebUiStateError);
      assert.equal(err.kind, "gemini_deep_think_generation_failed");
      assert.equal(err.status, 502);
      assert.match(err.message, /wasn't able to finish thinking/i);
      return true;
    }
  );

  const durationMs = Date.now() - start;
  assert.ok(
    durationMs < 1000,
    `Expected failure in < 1000ms, took ${durationMs}ms (should not wait for 10000ms timeout)`
  );
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("Task 2: DOM success resolution when network only emits placeholder", async () => {
  const placeholderBody =
    ')]}\'\n[["wrb.fr",null,"[[null,null,null,null,[null,null,null,null,[\\"Responses with Deep Think can take some time\\\\n\\\\n http://googleusercontent.com/agentic_processing_chip/0\\"]]]]"]]';

  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    streamResponses: [{ status: 200, body: placeholderBody, delayMs: 5 }],
    domResponseTexts: ["Detailed proof successfully computed by Gemini Deep Think."],
    domResponseDelayMs: 30,
  });

  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt: "Prompt where network stalls on placeholder",
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  const parsed = parseStreamResponse(rawResponse);
  assert.equal(parsed, "Detailed proof successfully computed by Gemini Deep Think.");
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("Task 2: DOM resolution when network emits len: 0 (empty body)", async () => {
  const mockPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    streamResponses: [{ status: 200, body: "", delayMs: 5 }],
    domResponseTexts: ["Answer recovered via DOM after empty network stream"],
    domResponseDelayMs: 30,
  });

  const rawResponse = await runGeminiDeepThinkUiStateMachine({
    page: mockPage as unknown as Page,
    prompt: "Prompt where network emits empty chunk",
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });

  const parsed = parseStreamResponse(rawResponse);
  assert.equal(parsed, "Answer recovered via DOM after empty network stream");
  assert.equal(mockPage.state.responseListenersCount, 0);
});

test("Task 2: Cleanup in finally for all paths (DOM success, DOM failure, timeout, abort)", async () => {
  // 1. DOM success path cleanup
  const successPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    neverRespond: true,
    domResponseTexts: ["DOM success answer"],
    domResponseDelayMs: 10,
  });
  await runGeminiDeepThinkUiStateMachine({
    page: successPage as unknown as Page,
    prompt: "DOM success",
    signal: new AbortController().signal,
    timeoutMs: 5000,
  });
  assert.equal(successPage.state.responseListenersCount, 0);

  // 2. DOM failure path cleanup
  const failurePage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    neverRespond: true,
    domResponseTexts: ["Gemini wasn't able to finish thinking."],
    domResponseDelayMs: 10,
  });
  await assert.rejects(async () => {
    await runGeminiDeepThinkUiStateMachine({
      page: failurePage as unknown as Page,
      prompt: "DOM failure",
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
  });
  assert.equal(failurePage.state.responseListenersCount, 0);

  // 3. Timeout path cleanup
  const timeoutPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    neverRespond: true,
    domResponseTexts: [],
  });
  await assert.rejects(async () => {
    await runGeminiDeepThinkUiStateMachine({
      page: timeoutPage as unknown as Page,
      prompt: "Timeout path",
      signal: new AbortController().signal,
      timeoutMs: 50,
    });
  });
  assert.equal(timeoutPage.state.responseListenersCount, 0);

  // 4. Abort path cleanup
  const abortPage = createMockPage({
    initialModePickerAriaLabel: "Open mode picker, currently Pro Deep Think",
    initialModePickerText: "Pro\nDeep Think",
    neverRespond: true,
  });
  const ac = new AbortController();
  const abortPromise = runGeminiDeepThinkUiStateMachine({
    page: abortPage as unknown as Page,
    prompt: "Abort path",
    signal: ac.signal,
    timeoutMs: 5000,
  });
  setTimeout(() => ac.abort(new Error("Client cancelled")), 15);
  await assert.rejects(abortPromise);
  assert.equal(abortPage.state.responseListenersCount, 0);
});
