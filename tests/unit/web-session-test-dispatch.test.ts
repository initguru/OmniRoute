import test from "node:test";
import assert from "node:assert/strict";

const { shouldUseApiKeyConnectionTest } =
  await import("../../src/app/api/providers/[id]/test/webSessionTestDispatch.ts");
const { providerAllowsOptionalApiKey, isWebCookieProvider } =
  await import("../../src/shared/constants/providers.ts");
const { validateGeminiWebProvider } =
  await import("../../src/lib/providers/validation/webProvidersB.ts");

test("shouldUseApiKeyConnectionTest - cookie auth for web cookie providers", () => {
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "gemini-web"), true);
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "claude-web"), true);
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "chatgpt-web"), true);
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "deepseek-web"), true);
});

test("shouldUseApiKeyConnectionTest - apikey auth for openai", () => {
  assert.equal(shouldUseApiKeyConnectionTest("apikey", "openai"), true);
});

test("shouldUseApiKeyConnectionTest - oauth auth for gemini-web", () => {
  assert.equal(shouldUseApiKeyConnectionTest("oauth", "gemini-web"), false);
});

test("providerAllowsOptionalApiKey - web cookie providers allow optional apiKey", () => {
  assert.equal(isWebCookieProvider("gemini-web"), true);
  assert.equal(isWebCookieProvider("claude-web"), true);
  assert.equal(providerAllowsOptionalApiKey("gemini-web"), true);
  assert.equal(providerAllowsOptionalApiKey("claude-web"), true);
  assert.equal(providerAllowsOptionalApiKey("deepseek-web"), true);
  assert.equal(providerAllowsOptionalApiKey("chatgpt-web"), true);
});

test("validateGeminiWebProvider - accepts cookie from providerSpecificData when apiKey is empty", async () => {
  // Without apiKey or providerSpecificData.cookie, should fail with prompt to paste cookie
  const missingResult = await validateGeminiWebProvider({ apiKey: "", providerSpecificData: {} });
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.error, /Paste your __Secure-1PSID cookie/);

  // When providerSpecificData.cookie is provided, validateGeminiWebProvider attempts validation instead of rejecting immediately
  const res = await validateGeminiWebProvider({
    apiKey: "",
    providerSpecificData: { cookie: "__Secure-1PSID=test-cookie-value;" },
  });
  // Should have processed the cookie from providerSpecificData (may fail downstream on network/session but not "Paste your __Secure-1PSID cookie")
  assert.notEqual(res.error, "Paste your __Secure-1PSID cookie from gemini.google.com");
});
