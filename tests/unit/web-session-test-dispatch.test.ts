import test from "node:test";
import assert from "node:assert/strict";

const { shouldUseApiKeyConnectionTest } =
  await import("../../src/app/api/providers/[id]/test/webSessionTestDispatch.ts");

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
