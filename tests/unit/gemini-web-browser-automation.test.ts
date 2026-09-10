import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import {
  runGeminiDeepThinkUiStateMachine,
  GeminiWebUiStateError,
} from "../../open-sse/executors/gemini-web/browserAutomation.ts";

interface MockPageOptions {
  initialModePickerAriaLabel?: string;
  proMenuItemExists?: boolean;
  proMenuItemAriaDisabled?: string;
  proClickUpdatesModePicker?: boolean;
  deepThinkExists?: boolean;
  deepThinkAriaDisabled?: string;
  deepThinkInitiallyActive?: boolean;
  deepThinkClickActivates?: boolean;
  composerExists?: boolean;
  composerAcceptsFill?: boolean;
  streamResponseStatus?: number;
  streamResponseBody?: string;
  streamResponseDelayMs?: number;
  neverRespond?: boolean;
}

function createMockPage(options: MockPageOptions = {}) {
  const {
    initialModePickerAriaLabel = "Open mode picker, currently Fast",
    proMenuItemExists = true,
    proMenuItemAriaDisabled = "false",
    proClickUpdatesModePicker = true,
    deepThinkExists = true,
    deepThinkAriaDisabled = "false",
    deepThinkInitiallyActive = false,
    deepThinkClickActivates = true,
    composerExists = true,
    composerAcceptsFill = true,
    streamResponseStatus = 200,
    streamResponseBody = ')]}\'\n[["wrb.fr",null,"[[null,null,null,null,[null,null,null,null,[\\"Deep Think Result\\"]]]]"]]',
    streamResponseDelayMs = 5,
    neverRespond = false,
  } = options;

  let currentModePickerAriaLabel = initialModePickerAriaLabel;
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
          click: async () => {},
        };
      }

      // Pro menu item
      if (selector.includes("bard-mode-option-9d8ca3786ebdfbea") || selector.includes("3.1 Pro")) {
        return {
          first: () => this.locator(selector),
          count: async () => (proMenuItemExists ? 1 : 0),
          getAttribute: async (attr: string) => {
            if (attr === "aria-disabled") return proMenuItemAriaDisabled;
            return null;
          },
          click: async () => {
            if (proClickUpdatesModePicker) {
              currentModePickerAriaLabel = "Open mode picker, currently 3.1 Pro";
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
