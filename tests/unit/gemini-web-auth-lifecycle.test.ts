import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canUpdateProviderApiKey } from "../../src/shared/providers/webSessionCredentials.ts";
import { WEB_COOKIE_PROVIDERS_WITHOUT_AUTH_PROBE } from "../../src/lib/providers/validation/transport.ts";
import { validateWebCookieProvider } from "../../src/lib/providers/validation/webCookie.ts";
import {
  fetchGeminiWebQuota,
  clearGeminiWebQuotaCache,
} from "../../open-sse/services/geminiWebQuotaFetcher.ts";
import {
  recoverGeminiWebSessionWithBrowser,
  clearInFlightRecoveries,
} from "../../open-sse/executors/gemini-web/sessionRecovery.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/quota-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("Gemini Web Auth Lifecycle & Cookie Desync", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearGeminiWebQuotaCache();
    clearInFlightRecoveries();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearGeminiWebQuotaCache();
    clearInFlightRecoveries();
  });

  describe("1. canUpdateProviderApiKey for gemini-web", () => {
    it("allows updating apiKey column for gemini-web when authType is cookie", () => {
      assert.equal(
        canUpdateProviderApiKey("cookie", "gemini-web"),
        true,
        "gemini-web must allow updating apiKey column even with authType: cookie so user-provided cookies are saved to DB"
      );
    });

    it("preserves default behavior for other web cookie and token providers", () => {
      assert.equal(canUpdateProviderApiKey("apikey", "gemini-web"), true);
      assert.equal(canUpdateProviderApiKey("cookie", "perplexity-web"), false);
      assert.equal(canUpdateProviderApiKey("cookie", "claude-web"), false);
      assert.equal(canUpdateProviderApiKey("cookie", "deepseek-web"), true);
      assert.equal(canUpdateProviderApiKey("cookie", "zai-web"), true);
    });
  });

  describe("2. WEB_COOKIE_PROVIDERS_WITHOUT_AUTH_PROBE includes gemini-web", () => {
    it("includes gemini-web in WEB_COOKIE_PROVIDERS_WITHOUT_AUTH_PROBE", () => {
      assert.equal(
        WEB_COOKIE_PROVIDERS_WITHOUT_AUTH_PROBE.has("gemini-web"),
        true,
        "gemini-web must be registered in WEB_COOKIE_PROVIDERS_WITHOUT_AUTH_PROBE to prevent false SESSION_EXPIRED on non-existent /app/models"
      );
    });

    it("returns unsupported without attempting outbound /models probe for gemini-web", async () => {
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const result = await validateWebCookieProvider({
        provider: "gemini-web",
        apiKey: "__Secure-1PSID=test-psid; __Secure-1PSIDTS=test-ts",
      });

      assert.equal(result.valid, false);
      assert.equal(result.unsupported, true);
      assert.equal(fetchCalled, false, "outbound probe must NOT be dispatched for gemini-web");
    });
  });

  describe("3. geminiWebQuotaFetcher uses mergedCookie from bootstrap", () => {
    it("uses updated mergedCookie in the subsequent batchexecute request", async () => {
      let batchexecuteCookieHeader = "";

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr === "https://gemini.google.com/app") {
          const res = new Response(
            '<html><body><script>"SNlM0e":"bootstrapped-at","FdrFJe":"bootstrapped-fsid","cfb2h":"bootstrapped-bl"</script></body></html>',
            {
              status: 200,
              headers: {
                "set-cookie":
                  "__Secure-1PSIDTS=rotated-ts-999; Path=/; Domain=.google.com; Secure; HttpOnly",
              },
            }
          );
          return res;
        }

        if (urlStr.includes("batchexecute")) {
          const headers = (init?.headers as Record<string, string>) || {};
          batchexecuteCookieHeader = headers["Cookie"] || headers["cookie"] || "";
          return new Response(fixture.quotaResponseSample, { status: 200 });
        }

        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const connection = {
        apiKey: "__Secure-1PSID=initial-psid; __Secure-1PSIDTS=initial-ts",
      };

      const result = await fetchGeminiWebQuota("conn-desync-test", connection);
      assert.ok(result, "quota should be fetched successfully");
      assert.match(
        batchexecuteCookieHeader,
        /__Secure-1PSIDTS=rotated-ts-999/,
        "batchexecute request must use the merged cookie with rotated-ts-999 from bootstrap"
      );
      assert.match(
        batchexecuteCookieHeader,
        /__Secure-1PSID=initial-psid/,
        "batchexecute request must preserve original __Secure-1PSID"
      );
    });
  });

  describe("4. sessionRecovery early detection of unauthenticated landing page", () => {
    it("returns login_required early when DOM has Sign in / 로그인 or unauthenticated landing state", async () => {
      const mockPage = {
        goto: mock.fn(async () => {}),
        url: mock.fn(() => "https://gemini.google.com/app"),
        evaluate: mock.fn(async () => {
          // Unauthenticated landing page: no .ql-editor and no SNlM0e token, with Sign in visible
          return {
            __loginRequired: true,
          };
        }),
        waitForSelector: mock.fn(async () => {}),
        close: mock.fn(async () => {}),
      };

      const mockContext = {
        addCookies: mock.fn(async () => {}),
        newPage: mock.fn(async () => mockPage),
        cookies: mock.fn(async () => []),
        close: mock.fn(async () => {}),
      };

      const mockBrowser = {
        newContext: mock.fn(async () => mockContext),
        close: mock.fn(async () => {}),
      };

      const mockPlaywright = {
        chromium: {
          launch: mock.fn(async () => mockBrowser),
        },
      };

      const result = await recoverGeminiWebSessionWithBrowser({
        cookie: "__Secure-1PSID=expired-cookie",
        playwright: mockPlaywright,
      });

      assert.equal(result.success, false);
      assert.equal(result.error, "login_required");
      assert.equal(
        mockPage.waitForSelector.mock.callCount(),
        0,
        "should detect login_required early without waiting for composer selector"
      );
    });

    it("evaluates DOM in page context and identifies sign-in text in body", async () => {
      const mockPage = {
        goto: mock.fn(async () => {}),
        url: mock.fn(() => "https://gemini.google.com/app"),
        evaluate: mock.fn(async (fn?: () => unknown) => {
          if (typeof fn === "function") {
            const originalDoc = (globalThis as unknown as { document?: unknown }).document;
            try {
              (globalThis as unknown as { document?: unknown }).document = {
                body: { innerText: "Google 계정으로 로그인" },
                querySelector: () => null,
              };
              return fn();
            } finally {
              (globalThis as unknown as { document?: unknown }).document = originalDoc;
            }
          }
          return {};
        }),
        waitForSelector: mock.fn(async () => {}),
        close: mock.fn(async () => {}),
      };

      const mockContext = {
        addCookies: mock.fn(async () => {}),
        newPage: mock.fn(async () => mockPage),
        cookies: mock.fn(async () => []),
        close: mock.fn(async () => {}),
      };

      const mockBrowser = {
        newContext: mock.fn(async () => mockContext),
        close: mock.fn(async () => {}),
      };

      const mockPlaywright = {
        chromium: {
          launch: mock.fn(async () => mockBrowser),
        },
      };

      const result = await recoverGeminiWebSessionWithBrowser({
        cookie: "__Secure-1PSID=expired-cookie-kr",
        playwright: mockPlaywright,
      });

      assert.equal(result.success, false);
      assert.equal(result.error, "login_required");
      assert.equal(mockPage.waitForSelector.mock.callCount(), 0);
    });

    it("identifies unauthenticated landing state when .ql-editor and SNlM0e are missing", async () => {
      const mockPage = {
        goto: mock.fn(async () => {}),
        url: mock.fn(() => "https://gemini.google.com/app"),
        evaluate: mock.fn(async (fn?: () => unknown) => {
          if (typeof fn === "function") {
            const originalDoc = (globalThis as unknown as { document?: unknown }).document;
            const originalWin = (globalThis as unknown as { window?: unknown }).window;
            try {
              (globalThis as unknown as { document?: unknown }).document = {
                body: { innerText: "Supercharge your creativity and productivity" },
                querySelector: () => null,
              };
              (globalThis as unknown as { window?: unknown }).window = {
                WIZ_global_data: { cfb2h: "boq_bl" },
              };
              return fn();
            } finally {
              (globalThis as unknown as { document?: unknown }).document = originalDoc;
              (globalThis as unknown as { window?: unknown }).window = originalWin;
            }
          }
          return {};
        }),
        waitForSelector: mock.fn(async () => {}),
        close: mock.fn(async () => {}),
      };

      const mockContext = {
        addCookies: mock.fn(async () => {}),
        newPage: mock.fn(async () => mockPage),
        cookies: mock.fn(async () => []),
        close: mock.fn(async () => {}),
      };

      const mockBrowser = {
        newContext: mock.fn(async () => mockContext),
        close: mock.fn(async () => {}),
      };

      const mockPlaywright = {
        chromium: {
          launch: mock.fn(async () => mockBrowser),
        },
      };

      const result = await recoverGeminiWebSessionWithBrowser({
        cookie: "__Secure-1PSID=expired-cookie-landing",
        playwright: mockPlaywright,
      });

      assert.equal(result.success, false);
      assert.equal(result.error, "login_required");
      assert.equal(mockPage.waitForSelector.mock.callCount(), 0);
    });
  });
});
