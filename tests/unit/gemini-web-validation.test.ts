import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const { validateGeminiWebProvider } =
  await import("../../src/lib/providers/validation/webProvidersB.ts");

const originalFetch = globalThis.fetch;

describe("validateGeminiWebProvider — SNlM0e Anti-CSRF Token Validation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid: true when response is 200 and HTML contains "SNlM0e": (authenticated session)', async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("gemini.google.com/app")) {
        return new Response(
          '<html><head><script>window.WIZ_global_data = {"SNlM0e":"token_123","FdrFJe":"fsid_456"};</script></head><body><div class="ql-editor"></div></body></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      throw new Error(`Unexpected fetch to ${target}`);
    };

    const result = await validateGeminiWebProvider({
      apiKey: "__Secure-1PSID=valid-session-cookie",
    });

    assert.equal(result.valid, true);
    assert.equal(result.error, null);
  });

  it('returns valid: true when response is 200 and HTML contains "SNlM0e", (array-based WIZ_global_data)', async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("gemini.google.com/app")) {
        return new Response(
          '<html><head><script>window.WIZ_global_data = [["SNlM0e","token_abc"],["cfb2h","build_123"]];</script></head><body></body></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      throw new Error(`Unexpected fetch to ${target}`);
    };

    const result = await validateGeminiWebProvider({
      apiKey: "__Secure-1PSID=valid-session-cookie",
    });

    assert.equal(result.valid, true);
    assert.equal(result.error, null);
  });

  it("returns valid: false when response is 200 but HTML lacks SNlM0e (guest session)", async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("gemini.google.com/app")) {
        return new Response(
          '<html><head><title>Gemini</title></head><body><div id="guest-landing">Try Gemini as guest</div></body></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      throw new Error(`Unexpected fetch to ${target}`);
    };

    const result = await validateGeminiWebProvider({
      apiKey: "__Secure-1PSID=guest-or-expired-cookie",
    });

    assert.equal(result.valid, false);
    assert.equal(
      result.error,
      "Invalid or expired Gemini Web session: SNlM0e token not found (guest session). Please re-login at gemini.google.com and paste fresh cookies."
    );
  });

  it("returns valid: false when response is 200 and HTML contains ServiceLogin or guest indicators without SNlM0e", async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("gemini.google.com/app")) {
        return new Response(
          '<html><body><a href="https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app">Sign in</a></body></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      throw new Error(`Unexpected fetch to ${target}`);
    };

    const result = await validateGeminiWebProvider({
      apiKey: "__Secure-1PSID=guest-cookie",
    });

    assert.equal(result.valid, false);
    assert.equal(
      result.error,
      "Invalid or expired Gemini Web session: SNlM0e token not found (guest session). Please re-login at gemini.google.com and paste fresh cookies."
    );
  });
});
