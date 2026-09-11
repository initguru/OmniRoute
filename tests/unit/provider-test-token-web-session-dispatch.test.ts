import test from "node:test";
import assert from "node:assert/strict";

const { shouldUseApiKeyConnectionTest } =
  await import("../../src/app/api/providers/[id]/test/webSessionTestDispatch.ts");

test("normal API-key connections keep the API-key test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("apikey", "openai"), true);
});

test("token-kind cookie-auth web sessions use the API-key test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "deepseek-web"), true);

  assert.equal(shouldUseApiKeyConnectionTest("cookie", "zai-web"), true);
});

test("non-web-cookie sessions do not use the API-key test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "non-web-cookie-provider"), false);
});

test("token-kind web sessions WITHOUT a token-aware validator or web-cookie entry stay off the API-key test path", () => {
  // microsoft-designer-web and hailuo-web are retired provider ids that stay off every credential-test path.
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "hailuo-web"), false);
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "microsoft-designer-web"), false);
});

test("every token-kind web session with a real token-aware validator uses the API-key test path", () => {
  for (const providerId of [
    "deepseek-web",
    "kimi-web",
    "tinycms-web",
    "copilot-m365-web",
    "copilot-web",
    "zai-web",
  ]) {
    assert.equal(shouldUseApiKeyConnectionTest("cookie", providerId), true, providerId);
  }
});

test("retired Microsoft Designer cannot regain the positive web-session test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "microsoft-designer-web"), false);
});

test("other auth types are not broadened", () => {
  assert.equal(shouldUseApiKeyConnectionTest("oauth", "deepseek-web"), false);

  assert.equal(shouldUseApiKeyConnectionTest(null, "deepseek-web"), false);
});
