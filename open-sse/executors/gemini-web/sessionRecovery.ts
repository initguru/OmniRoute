/**
 * Headless Playwright Session Self-Healing Recovery Service for Gemini Web (Tier 2).
 *
 * Recovers session tokens (SNlM0e, FdrFJe, cfb2h) via headless Playwright when direct
 * HTTP bootstrap fails, and persists rotated __Secure-1PSID* cookies from the browser jar.
 */

import type { GeminiWebSessionTokens } from "./directProtocol.ts";
import { parseCookies, mergeRotatedGeminiCookies } from "./cookieUtils.ts";

export interface GeminiWebSessionRecoveryResult {
  success: boolean;
  tokens?: GeminiWebSessionTokens;
  mergedCookie?: string;
  error?: string;
}

export interface SessionRecoveryOptions {
  cookie: string;
  credentials?: Record<string, unknown>;
  onCredentialsRefreshed?: (creds: Record<string, unknown>) => Promise<void> | void;
  log?: {
    warn?: (tag: string, msg: string) => void;
    info?: (tag: string, msg: string) => void;
  } | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  playwright?: unknown; // Optional dependency injection for unit testing
}

interface RecoveryPage {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  evaluate: (fn: () => unknown) => Promise<unknown>;
  waitForSelector: (selector: string, opts?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

interface RecoveryContext {
  addCookies: (
    cookies: Array<{
      name: string;
      value: string;
      domain?: string;
      url?: string;
      path?: string;
      secure?: boolean;
    }>
  ) => Promise<void>;
  newPage: () => Promise<RecoveryPage>;
  cookies: (urls?: string[]) => Promise<Array<{ name: string; value: string }>>;
  close: () => Promise<void>;
}

interface RecoveryBrowser {
  newContext: (opts?: Record<string, unknown>) => Promise<RecoveryContext>;
  close: () => Promise<void>;
}

// Single-flight in-memory mutex keyed by primary auth cookie (__Secure-1PSID or cookie)
const inFlightRecoveries = new Map<string, Promise<GeminiWebSessionRecoveryResult>>();

export function clearInFlightRecoveries(): void {
  inFlightRecoveries.clear();
}

async function doRecoverGeminiWebSessionWithBrowser(
  options: SessionRecoveryOptions
): Promise<GeminiWebSessionRecoveryResult> {
  const { cookie, credentials, onCredentialsRefreshed, log, signal, timeoutMs, playwright } =
    options;

  if (signal?.aborted) {
    return {
      success: false,
      error: signal.reason instanceof Error ? signal.reason.message : "Request aborted",
    };
  }

  let browser: RecoveryBrowser | null = null;
  let context: RecoveryContext | null = null;
  let page: RecoveryPage | null = null;
  let onAbort: (() => void) | null = null;

  try {
    const pw = (playwright ?? (await import("playwright"))) as {
      chromium?: {
        launch: (opts?: Record<string, unknown>) => Promise<RecoveryBrowser>;
      };
    };

    if (!pw?.chromium?.launch) {
      return { success: false, error: "playwright_chromium_not_found" };
    }

    browser = (await pw.chromium.launch({ headless: true })) as RecoveryBrowser;
    if (!browser) {
      return { success: false, error: "failed_to_launch_browser" };
    }

    if (signal) {
      onAbort = () => {
        void browser?.close().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        return {
          success: false,
          error: signal.reason instanceof Error ? signal.reason.message : "Request aborted",
        };
      }
    }

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    if (!context) {
      return { success: false, error: "failed_to_create_context" };
    }

    const cookiePairs = parseCookies(cookie);
    if (cookiePairs.length > 0) {
      await context.addCookies(
        cookiePairs.map(({ name, value }) => {
          if (name.startsWith("__Host-")) {
            return {
              name,
              value,
              url: "https://gemini.google.com",
              path: "/",
              secure: true,
            };
          }
          return {
            name,
            value,
            domain: ".google.com",
            path: "/",
            secure: true,
          };
        })
      );
    }

    page = await context.newPage();
    if (!page) {
      return { success: false, error: "failed_to_create_page" };
    }

    const navTimeout = timeoutMs ? Math.min(timeoutMs, 15000) : 15000;
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: navTimeout,
    });

    const currentUrl = page.url() || "";
    if (currentUrl.includes("accounts.google.com") || currentUrl.includes("ServiceLogin")) {
      return { success: false, error: "login_required" };
    }

    await page
      .waitForSelector(
        ".ql-editor, [contenteditable='true'], a[href*='ServiceLogin'], button[aria-label*='Sign in'], button[aria-label*='로그인']",
        { timeout: 4000 }
      )
      .catch(() => {});

    let evalResult = (await page.evaluate(() => {
      const win = (typeof window !== "undefined" ? window : globalThis) as unknown as {
        WIZ_global_data?: Record<string, string>;
      };
      const wiz = win?.WIZ_global_data;
      const doc = typeof document !== "undefined" ? document : null;
      const text = doc?.body ? doc.body.innerText || "" : "";
      const hasSignIn =
        /Sign in|로그인/i.test(text) ||
        Boolean(
          doc?.querySelector?.(
            'a[href*="ServiceLogin"], a[href*="accounts.google.com"], [data-action="signin"], button[aria-label*="Sign in"], button[aria-label*="로그인"], [data-action="sign-in"]'
          )
        );
      const hasEditor = Boolean(doc?.querySelector?.(".ql-editor, [contenteditable='true']"));
      const atToken = wiz?.["SNlM0e"];

      if (!atToken && (hasSignIn || !hasEditor)) {
        return { __loginRequired: true, wiz };
      }

      return wiz;
    })) as Record<string, unknown> | undefined;

    if (
      evalResult?.["__loginRequired"] ||
      evalResult?.["login_required"] ||
      evalResult?.["isLoginRequired"]
    ) {
      return { success: false, error: "login_required" };
    }

    let wizData = (evalResult?.["wiz"] ?? evalResult) as Record<string, string> | undefined;
    let atToken = wizData?.["SNlM0e"];
    let fSid = wizData?.["FdrFJe"];
    let buildLabel = wizData?.["cfb2h"];

    if (!atToken || !fSid || !buildLabel) {
      try {
        await page.waitForSelector(".ql-editor, [contenteditable='true']", { timeout: 5000 });
        const secondResult = (await page.evaluate(() => {
          const win = (typeof window !== "undefined" ? window : globalThis) as unknown as {
            WIZ_global_data?: Record<string, string>;
          };
          return win?.WIZ_global_data;
        })) as Record<string, unknown> | undefined;
        wizData = (secondResult?.["wiz"] ?? secondResult) as Record<string, string> | undefined;
        atToken = wizData?.["SNlM0e"];
        fSid = wizData?.["FdrFJe"];
        buildLabel = wizData?.["cfb2h"];
      } catch {
        // Selector wait timed out or failed
      }
    }

    if (!atToken || !fSid || !buildLabel) {
      return { success: false, error: "tokens_not_found" };
    }

    let jarCookies: Array<{ name: string; value: string }> = [];
    try {
      const rawJar = await context.cookies(["https://gemini.google.com"]);
      if (Array.isArray(rawJar)) {
        jarCookies = rawJar.map((c) => ({
          name: c.name,
          value: c.value,
        }));
      }
    } catch (err) {
      log?.warn?.(
        "GEMINI-WEB",
        `Failed to read rotated cookies from browser context: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let mergedCookie: string | undefined;
    if (jarCookies.length > 0) {
      const merged = mergeRotatedGeminiCookies(cookie, jarCookies);
      if (merged && merged !== cookie) {
        mergedCookie = merged;
      }
    }

    if (mergedCookie && onCredentialsRefreshed) {
      try {
        await onCredentialsRefreshed({
          ...credentials,
          apiKey: mergedCookie,
        });
      } catch (err) {
        log?.warn?.(
          "GEMINI-WEB",
          `Failed to persist refreshed credentials from recovery: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      success: true,
      tokens: { atToken, fSid, buildLabel },
      ...(mergedCookie ? { mergedCookie } : {}),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log?.warn?.("GEMINI-WEB", `Tier 2 browser self-healing recovery failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export async function recoverGeminiWebSessionWithBrowser(
  options: SessionRecoveryOptions
): Promise<GeminiWebSessionRecoveryResult> {
  const { cookie } = options;
  const primaryKey = parseCookies(cookie).find((c) => c.name === "__Secure-1PSID")?.value || cookie;

  const existing = inFlightRecoveries.get(primaryKey);
  if (existing) {
    return existing;
  }

  const recoveryPromise = (async () => {
    try {
      return await doRecoverGeminiWebSessionWithBrowser(options);
    } finally {
      inFlightRecoveries.delete(primaryKey);
    }
  })();

  inFlightRecoveries.set(primaryKey, recoveryPromise);
  return recoveryPromise;
}
