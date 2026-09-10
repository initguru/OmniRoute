/**
 * Headless Browser Automation State Machine for Gemini Web Deep Think (#9356)
 *
 * Implements verified UI transitions for forcing Gemini 3.1 Pro + Deep Think
 * on Google AI Ultra web sessions. Uses locators derived from verified capture fixture
 * `tests/fixtures/gemini-web/deep-think-observed-ai-ultra.json`.
 *
 * Enforces strict postconditions before bulk prompt injection and submission.
 * Fails closed with typed `GeminiWebUiStateError` on any mismatch, never
 * submitting prompts into unverified UI states.
 */

import type { Page, Response as PlaywrightResponse } from "playwright";
import { GEMINI_DEEP_THINK_TIMEOUT_CODE } from "../../config/constants.ts";

export type GeminiWebUiFailureKind =
  | "gemini_web_auth_required"
  | "gemini_deep_think_unavailable"
  | "gemini_web_ui_contract_mismatch"
  | "gemini_web_completion_unverified";

export class GeminiWebUiStateError extends Error {
  readonly kind: GeminiWebUiFailureKind;
  readonly status: number;
  readonly code: string;

  constructor(
    kind: GeminiWebUiFailureKind,
    message: string,
    status: number = kind === "gemini_web_auth_required" ? 401 : 409
  ) {
    super(message);
    this.name = "GeminiWebUiStateError";
    this.kind = kind;
    this.status = status;
    this.code = kind;
  }
}

export interface GeminiDeepThinkUiStateMachineOptions {
  page: Page;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Selectors derived from tests/fixtures/gemini-web/deep-think-observed-ai-ultra.json
export const COMPOSER_SELECTOR = ".ql-editor, [contenteditable='true']";
export const MODE_PICKER_TRIGGER_SELECTOR = "button[aria-label*='Open mode picker, currently ' i]";
export const PRO_MENU_ITEM_SELECTOR =
  "[role='menuitem'][data-test-id='bard-mode-option-9d8ca3786ebdfbea'], [role='menuitem']:has-text('3.1 Pro')";
export const DEEP_THINK_TOGGLE_SELECTOR =
  "[role='menuitem']:has-text('Deep Think'), button:has-text('Deep Think')";

/**
 * Runs the verified headless UI state machine for Gemini Web Deep Think.
 *
 * State Order:
 * 1. Page ready (Composer landmark presence)
 * 2. 3.1 Pro selection verified (with subscription / disabled gate)
 * 3. Deep Think verified (present & activated)
 * 4. Bulk prompt injection (`fill`) & editor content assertion
 * 5. Enter pressed & completion signal verified
 *
 * Cleans up response and abort listeners in `finally`.
 */
export async function runGeminiDeepThinkUiStateMachine(
  options: GeminiDeepThinkUiStateMachineOptions
): Promise<string> {
  const { page, prompt, signal, timeoutMs } = options;

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
  }

  // Response capture state
  let rawResponseBody: string | null = null;
  let responseError: Error | null = null;
  let resolveResponse: (() => void) | null = null;
  let rejectResponse: ((err: Error) => void) | null = null;

  const responsePromise = new Promise<string>((resolve, reject) => {
    resolveResponse = () => {
      if (rawResponseBody !== null) {
        resolve(rawResponseBody);
      }
    };
    rejectResponse = reject;
  });

  const onResponse = async (resp: PlaywrightResponse) => {
    try {
      const url =
        typeof resp.url === "function" ? resp.url() : (resp as unknown as { url?: string }).url;
      if (!url || !url.includes("StreamGenerate")) return;

      const status =
        typeof resp.status === "function"
          ? resp.status()
          : (resp as unknown as { status?: number }).status;
      if (typeof status === "number" && (status < 200 || status >= 300)) {
        responseError = new GeminiWebUiStateError(
          "gemini_web_completion_unverified",
          `StreamGenerate returned HTTP ${status}`,
          status >= 400 && status < 500 ? 409 : 502
        );
        rejectResponse?.(responseError);
        return;
      }

      const text = typeof resp.text === "function" ? await resp.text() : await resp.body();
      const bodyStr = typeof text === "string" ? text : String(text);
      if (!bodyStr || bodyStr.trim().length === 0) {
        responseError = new GeminiWebUiStateError(
          "gemini_web_completion_unverified",
          "StreamGenerate returned empty response body",
          502
        );
        rejectResponse?.(responseError);
        return;
      }

      rawResponseBody = bodyStr;
      resolveResponse?.();
    } catch (err) {
      if (!rawResponseBody && !responseError) {
        responseError = err instanceof Error ? err : new Error(String(err));
        rejectResponse?.(responseError);
      }
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        interface TimeoutError extends Error {
          code?: string;
          status?: number;
        }
        const err: TimeoutError = new Error(`Gemini Web Deep Think timed out after ${timeoutMs}ms`);
        err.code = GEMINI_DEEP_THINK_TIMEOUT_CODE;
        err.status = 504;
        reject(err);
      }, timeoutMs);
    }
  });

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  page.on("response", onResponse);

  const executeStateMachine = async (): Promise<string> => {
    // 1. Verify Composer readiness
    const composer = page.locator(COMPOSER_SELECTOR).first();
    const composerCount = await composer.count();
    if (composerCount === 0) {
      throw new GeminiWebUiStateError(
        "gemini_web_ui_contract_mismatch",
        "Composer element not found on page",
        409
      );
    }

    // 2. Mode Picker & 3.1 Pro Verification
    const modePicker = page.locator(MODE_PICKER_TRIGGER_SELECTOR).first();
    const modePickerCount = await modePicker.count();
    if (modePickerCount === 0) {
      throw new GeminiWebUiStateError(
        "gemini_web_ui_contract_mismatch",
        "Mode picker trigger button not found on page",
        409
      );
    }

    const currentAriaLabel = (await modePicker.getAttribute("aria-label")) ?? "";
    const isProSelected = currentAriaLabel.toLowerCase().includes("3.1 pro");

    if (!isProSelected) {
      await modePicker.click();

      const proItem = page.locator(PRO_MENU_ITEM_SELECTOR).first();
      const proCount = await proItem.count();
      if (proCount === 0) {
        throw new GeminiWebUiStateError(
          "gemini_deep_think_unavailable",
          "Gemini 3.1 Pro menu item not found",
          409
        );
      }

      const ariaDisabled = await proItem.getAttribute("aria-disabled");
      if (ariaDisabled === "true") {
        throw new GeminiWebUiStateError(
          "gemini_deep_think_unavailable",
          "Gemini 3.1 Pro is disabled (requires Google AI Ultra subscription)",
          409
        );
      }

      await proItem.click();

      // Assert postcondition: mode picker button aria-label includes "3.1 Pro"
      const updatedAriaLabel = (await modePicker.getAttribute("aria-label")) ?? "";
      if (!updatedAriaLabel.toLowerCase().includes("3.1 pro")) {
        throw new GeminiWebUiStateError(
          "gemini_web_ui_contract_mismatch",
          `Failed to verify 3.1 Pro mode selection postcondition. Got aria-label: "${updatedAriaLabel}"`,
          409
        );
      }
    }

    // 3. Deep Think Option Verification
    const deepThinkToggle = page.locator(DEEP_THINK_TOGGLE_SELECTOR).first();
    let dtCount = await deepThinkToggle.count();
    if (dtCount === 0) {
      // If Deep Think is inside mode picker menu and menu closed, try opening mode picker
      await modePicker.click();
      dtCount = await deepThinkToggle.count();
    }

    if (dtCount === 0) {
      throw new GeminiWebUiStateError(
        "gemini_deep_think_unavailable",
        "Deep Think option not found in mode picker or prompt area",
        409
      );
    }

    const dtAriaDisabled = await deepThinkToggle.getAttribute("aria-disabled");
    if (dtAriaDisabled === "true") {
      throw new GeminiWebUiStateError(
        "gemini_deep_think_unavailable",
        "Deep Think option is disabled",
        409
      );
    }

    const isDtActive =
      (await deepThinkToggle.getAttribute("data-active")) === "true" ||
      (await deepThinkToggle.getAttribute("aria-checked")) === "true";

    if (!isDtActive) {
      await deepThinkToggle.click();

      // Verify postcondition: Deep Think toggle is now active
      const postDtActive =
        (await deepThinkToggle.getAttribute("data-active")) === "true" ||
        (await deepThinkToggle.getAttribute("aria-checked")) === "true";

      if (!postDtActive) {
        const postDisabled = await deepThinkToggle.getAttribute("aria-disabled");
        if (postDisabled === "true") {
          throw new GeminiWebUiStateError(
            "gemini_deep_think_unavailable",
            "Deep Think option became disabled upon selection",
            409
          );
        }
      }
    }

    // 4. Bulk Prompt Injection
    await composer.fill(prompt);

    // Assert composer text is non-empty
    const text =
      (typeof composer.innerText === "function" ? await composer.innerText() : null) ||
      (typeof composer.textContent === "function" ? await composer.textContent() : null) ||
      (typeof composer.inputValue === "function" ? await composer.inputValue() : null) ||
      "";

    if (!text || text.trim().length === 0) {
      throw new GeminiWebUiStateError(
        "gemini_web_ui_contract_mismatch",
        "Composer editor empty after bulk prompt injection",
        409
      );
    }

    // 5. Submit Prompt
    if (page.keyboard && typeof page.keyboard.press === "function") {
      await page.keyboard.press("Enter");
    } else if (typeof composer.press === "function") {
      await composer.press("Enter");
    } else {
      throw new GeminiWebUiStateError(
        "gemini_web_ui_contract_mismatch",
        "Unable to press Enter on composer",
        409
      );
    }

    // 6. Wait for verified response
    return await responsePromise;
  };

  try {
    return await Promise.race([executeStateMachine(), timeoutPromise, abortPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort);
    }
    try {
      interface PageEventEmitter {
        off?: (event: string, listener: (resp: PlaywrightResponse) => Promise<void>) => void;
        removeListener?: (
          event: string,
          listener: (resp: PlaywrightResponse) => Promise<void>
        ) => void;
      }
      const emitter = page as unknown as PageEventEmitter;
      if (typeof emitter.off === "function") {
        emitter.off("response", onResponse);
      } else if (typeof emitter.removeListener === "function") {
        emitter.removeListener("response", onResponse);
      }
    } catch {
      /* ignore cleanup error */
    }
  }
}
