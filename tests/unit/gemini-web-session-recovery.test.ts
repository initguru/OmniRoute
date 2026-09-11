import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  recoverGeminiWebSessionWithBrowser,
  clearInFlightRecoveries,
} from "../../open-sse/executors/gemini-web/sessionRecovery.ts";

describe("recoverGeminiWebSessionWithBrowser (Tier 2 self-healing)", () => {
  beforeEach(() => {
    clearInFlightRecoveries();
  });

  it("extracts WIZ_global_data and rotated jar cookies, triggers onCredentialsRefreshed, returns success: true", async () => {
    const mockPage = {
      goto: mock.fn(async () => {}),
      url: mock.fn(() => "https://gemini.google.com/app"),
      evaluate: mock.fn(async () => ({
        SNlM0e: "test-at-token-abc",
        FdrFJe: "test-fsid-123",
        cfb2h: "boq_assistant-bard-web-server_20260907.07_p0",
      })),
      waitForSelector: mock.fn(async () => {}),
      close: mock.fn(async () => {}),
    };

    const mockContext = {
      addCookies: mock.fn(async () => {}),
      newPage: mock.fn(async () => mockPage),
      cookies: mock.fn(async () => [{ name: "__Secure-1PSIDTS", value: "rotated-ts-browser-999" }]),
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

    let refreshedCreds: Record<string, unknown> | null = null;
    const initialCookie = "__Secure-1PSID=test-psid; __Secure-1PSIDTS=initial-ts";

    const result = await recoverGeminiWebSessionWithBrowser({
      cookie: initialCookie,
      credentials: { apiKey: initialCookie, extraField: "preserved" },
      onCredentialsRefreshed: async (creds) => {
        refreshedCreds = creds;
      },
      playwright: mockPlaywright,
      timeoutMs: 10000,
    });

    assert.equal(result.success, true);
    assert.ok(result.tokens);
    assert.equal(result.tokens.atToken, "test-at-token-abc");
    assert.equal(result.tokens.fSid, "test-fsid-123");
    assert.equal(result.tokens.buildLabel, "boq_assistant-bard-web-server_20260907.07_p0");

    assert.ok(result.mergedCookie);
    assert.match(result.mergedCookie, /__Secure-1PSIDTS=rotated-ts-browser-999/);
    assert.match(result.mergedCookie, /__Secure-1PSID=test-psid/);

    assert.ok(refreshedCreds);
    assert.equal((refreshedCreds as Record<string, unknown>).extraField, "preserved");
    assert.match(
      (refreshedCreds as Record<string, unknown>).apiKey as string,
      /rotated-ts-browser-999/
    );

    // Verify cleanup
    assert.equal(mockPage.close.mock.callCount(), 1);
    assert.equal(mockContext.close.mock.callCount(), 1);
    assert.equal(mockBrowser.close.mock.callCount(), 1);

    // Verify cookie formatting passed to addCookies
    assert.equal(mockContext.addCookies.mock.callCount(), 1);
    const addedCookies = mockContext.addCookies.mock.calls[0].arguments[0] as Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
    }>;
    assert.equal(addedCookies.length, 2);
    assert.equal(addedCookies[0].domain, ".google.com");
    assert.equal(addedCookies[0].path, "/");
  });

  it("shares the same single-flight promise for concurrent recovery calls with identical cookie", async () => {
    let resolveLaunch: (value: unknown) => void = () => {};
    const launchPromise = new Promise((resolve) => {
      resolveLaunch = resolve;
    });

    const mockPage = {
      goto: mock.fn(async () => {}),
      url: mock.fn(() => "https://gemini.google.com/app"),
      evaluate: mock.fn(async () => ({
        SNlM0e: "concurrent-at",
        FdrFJe: "concurrent-fsid",
        cfb2h: "concurrent-build",
      })),
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
        launch: mock.fn(async () => {
          await launchPromise;
          return mockBrowser;
        }),
      },
    };

    const cookie = "__Secure-1PSID=same-user-cookie";

    const call1 = recoverGeminiWebSessionWithBrowser({
      cookie,
      playwright: mockPlaywright,
    });
    const call2 = recoverGeminiWebSessionWithBrowser({
      cookie,
      playwright: mockPlaywright,
    });

    resolveLaunch(null);

    const [res1, res2] = await Promise.all([call1, call2]);

    assert.equal(mockPlaywright.chromium.launch.mock.callCount(), 1);
    assert.equal(res1.success, true);
    assert.equal(res2.success, true);
    assert.equal(res1.tokens?.atToken, "concurrent-at");
    assert.equal(res2.tokens?.atToken, "concurrent-at");
  });

  it("returns success: false, error: 'login_required' when redirected to accounts.google.com or ServiceLogin", async () => {
    const mockPage = {
      goto: mock.fn(async () => {}),
      url: mock.fn(
        () => "https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app"
      ),
      evaluate: mock.fn(async () => ({})),
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
      cookie: "__Secure-1PSID=expired-psid",
      playwright: mockPlaywright,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "login_required");
    assert.equal(mockBrowser.close.mock.callCount(), 1);
  });

  it("gracefully returns success: false on missing browser executable or launch failure", async () => {
    const mockPlaywright = {
      chromium: {
        launch: mock.fn(async () => {
          throw new Error(
            "Executable doesn't exist at /root/.cache/ms-playwright/chromium-1155/chrome-linux/chrome"
          );
        }),
      },
    };

    const result = await recoverGeminiWebSessionWithBrowser({
      cookie: "__Secure-1PSID=any-psid",
      playwright: mockPlaywright,
    });

    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.match(result.error, /executable doesn't exist/i);
  });

  it("falls back to waiting for composer selector if WIZ_global_data is initially missing", async () => {
    let evalCount = 0;
    const mockPage = {
      goto: mock.fn(async () => {}),
      url: mock.fn(() => "https://gemini.google.com/app"),
      evaluate: mock.fn(async () => {
        evalCount++;
        if (evalCount === 1) {
          return {};
        }
        return {
          SNlM0e: "delayed-at-token",
          FdrFJe: "delayed-fsid",
          cfb2h: "delayed-build",
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
      cookie: "__Secure-1PSID=psid",
      playwright: mockPlaywright,
    });

    assert.equal(result.success, true);
    assert.equal(result.tokens?.atToken, "delayed-at-token");
    assert.equal(mockPage.waitForSelector.mock.callCount(), 1);
  });
});
