import test from "node:test";
import assert from "node:assert/strict";

import {
  TOKEN_EXTRACTION_CONFIGS,
  formatGeminiWebCookies,
  formatExtractedCookies,
} from "../../open-sse/services/tokenExtractionConfig.ts";

import {
  extractGeminiWebCookies,
  formatGeminiWebCookieString,
  saveGeminiWebCredential,
  parseAndSaveGeminiWebCookies,
  runGeminiWebLogin,
} from "../../bin/cli/commands/login.mjs";

test("Test Case 1: TOKEN_EXTRACTION_CONFIGS.get('gemini-web') includes __Secure-1PSID, __Secure-1PSIDTS, and __Secure-1PSIDCC", () => {
  const cfg = TOKEN_EXTRACTION_CONFIGS.get("gemini-web");
  assert.ok(cfg, "gemini-web extraction config must exist");
  assert.equal(cfg.providerId, "gemini-web");
  assert.equal(cfg.displayName, "Gemini Web");
  assert.equal(cfg.loginUrl, "https://gemini.google.com/app");
  assert.equal(cfg.homeUrl, "https://gemini.google.com");

  const sources = cfg.tokenSources;
  assert.equal(sources.length, 3, "gemini-web must have 3 token sources");

  const psid = sources.find((s) => s.type === "cookie" && s.name === "__Secure-1PSID");
  const psidts = sources.find((s) => s.type === "cookie" && s.name === "__Secure-1PSIDTS");
  const psidcc = sources.find((s) => s.type === "cookie" && s.name === "__Secure-1PSIDCC");

  assert.ok(psid, "must include __Secure-1PSID");
  assert.equal(psid?.domain, ".google.com");

  assert.ok(psidts, "must include __Secure-1PSIDTS");
  assert.equal(psidts?.domain, ".google.com");

  assert.ok(psidcc, "must include __Secure-1PSIDCC");
  assert.equal(psidcc?.domain, ".google.com");
});

test("Test Case 2: Cookie extraction correctly maps cookies to the unified formatted apiKey", () => {
  // Test with array of cookie objects
  const rawCookieArray = [
    { name: "NID", value: "random-google-nid", domain: ".google.com" },
    { name: "__Secure-1PSID", value: "test-psid-val-123", domain: ".google.com" },
    { name: "__Secure-1PSIDTS", value: "test-psidts-val-456", domain: ".google.com" },
    { name: "__Secure-1PSIDCC", value: "test-psidcc-val-789", domain: ".google.com" },
    { name: "APISID", value: "random-apisid", domain: ".google.com" },
  ];

  const formattedFromArray = formatGeminiWebCookies(rawCookieArray);
  assert.equal(
    formattedFromArray,
    "__Secure-1PSID=test-psid-val-123; __Secure-1PSIDTS=test-psidts-val-456; __Secure-1PSIDCC=test-psidcc-val-789"
  );

  // Test alias formatExtractedCookies
  assert.equal(formatExtractedCookies(rawCookieArray), formattedFromArray);

  // Test with record/dictionary
  const rawRecord = {
    "__Secure-1PSID": "sid-abc",
    "__Secure-1PSIDTS": "ts-def",
    "__Secure-1PSIDCC": "cc-ghi",
    unrelated_token: "ignored",
  };
  const formattedFromRecord = formatGeminiWebCookies(rawRecord);
  assert.equal(
    formattedFromRecord,
    "__Secure-1PSID=sid-abc; __Secure-1PSIDTS=ts-def; __Secure-1PSIDCC=cc-ghi"
  );

  // Test partial cookies (PSID + PSIDTS without PSIDCC)
  const partialArray = [
    { name: "__Secure-1PSID", value: "psid-only" },
    { name: "__Secure-1PSIDTS", value: "psidts-only" },
  ];
  assert.equal(
    formatGeminiWebCookies(partialArray),
    "__Secure-1PSID=psid-only; __Secure-1PSIDTS=psidts-only"
  );

  // Test CLI helper formatGeminiWebCookieString
  assert.equal(
    formatGeminiWebCookieString(rawCookieArray),
    "__Secure-1PSID=test-psid-val-123; __Secure-1PSIDTS=test-psidts-val-456; __Secure-1PSIDCC=test-psidcc-val-789"
  );
});

test("Test Case 3: CLI login gemini-web helper function parses and saves cookies correctly", async () => {
  const sampleCookies = [
    { name: "__Secure-1PSID", value: "psid-live", domain: ".google.com" },
    { name: "__Secure-1PSIDTS", value: "psidts-live", domain: ".google.com" },
    { name: "__Secure-1PSIDCC", value: "psidcc-live", domain: ".google.com" },
    { name: "OTHER", value: "other-val", domain: ".example.com" },
  ];

  // 1. extractGeminiWebCookies
  const extracted = extractGeminiWebCookies(sampleCookies);
  assert.ok(extracted, "Must extract cookies successfully");
  assert.equal(extracted.psid, "psid-live");
  assert.equal(extracted.psidts, "psidts-live");
  assert.equal(extracted.psidcc, "psidcc-live");
  assert.equal(
    extracted.formatted,
    "__Secure-1PSID=psid-live; __Secure-1PSIDTS=psidts-live; __Secure-1PSIDCC=psidcc-live"
  );

  // 2. parseAndSaveGeminiWebCookies with mock saveCredential
  let savedApiKey: string | null = null;
  const parseResult = await parseAndSaveGeminiWebCookies(sampleCookies, {
    saveCredential: async (apiKey: string) => {
      savedApiKey = apiKey;
      return { success: true };
    },
  });

  assert.equal(parseResult.success, true);
  assert.equal(
    savedApiKey,
    "__Secure-1PSID=psid-live; __Secure-1PSIDTS=psidts-live; __Secure-1PSIDCC=psidcc-live"
  );

  // 3. saveGeminiWebCredential with mock database
  let upsertCalledWith: Record<string, unknown> | null = null;
  const mockDb = {
    close: () => {},
  };
  const saveResult = await saveGeminiWebCredential(
    "__Secure-1PSID=psid-test; __Secure-1PSIDTS=ts-test; __Secure-1PSIDCC=cc-test",
    {
      isServerUp: async () => false,
      openOmniRouteDb: async () => ({ db: mockDb }),
      listProviderConnections: () => [
        { provider: "gemini-web", authType: "apikey", name: "my-gemini" },
      ],
      upsertApiKeyProviderConnection: (_db: unknown, input: Record<string, unknown>) => {
        upsertCalledWith = input;
        return { id: "conn-1" };
      },
    }
  );

  assert.equal(saveResult.success, true);
  assert.equal(upsertCalledWith?.provider, "gemini-web");
  assert.equal(upsertCalledWith?.name, "my-gemini");
  assert.equal(
    upsertCalledWith?.apiKey,
    "__Secure-1PSID=psid-test; __Secure-1PSIDTS=ts-test; __Secure-1PSIDCC=cc-test"
  );

  // 4. runGeminiWebLogin with mock browser orchestration
  let browserClosed = false;
  let loggedMessages: string[] = [];
  const mockBrowser = {
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => {},
        url: () => "https://gemini.google.com/app",
        locator: (_sel: string) => ({
          count: async () => 1,
        }),
      }),
      cookies: async () => sampleCookies,
    }),
    close: async () => {
      browserClosed = true;
    },
  };

  let loginSavedKey: string | null = null;
  const loginResult = await runGeminiWebLogin(
    { headless: true, timeout: 5000 },
    {
      browser: mockBrowser,
      pollIntervalMs: 10,
      saveCredential: async (key: string) => {
        loginSavedKey = key;
        return { success: true };
      },
      log: (msg: string) => loggedMessages.push(msg),
      print: (msg: string) => loggedMessages.push(msg),
    }
  );

  assert.equal(loginResult.success, true);
  assert.equal(
    loginSavedKey,
    "__Secure-1PSID=psid-live; __Secure-1PSIDTS=psidts-live; __Secure-1PSIDCC=psidcc-live"
  );
  assert.equal(browserClosed, true, "Browser must be closed gracefully");
  assert.ok(
    loggedMessages.some((m) => m.includes("Google 계정 로그인")),
    "Must output login instructions"
  );
});
