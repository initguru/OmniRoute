import test from "node:test";
import assert from "node:assert/strict";
import { AutoRefreshDaemon } from "../../open-sse/services/autoRefreshDaemon";

test("Test Case 1: validateCredential includes Cookie: entry.value in request headers", async () => {
  const daemon = new AutoRefreshDaemon();
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> | null = null;
  let capturedUrl: string | null = null;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = typeof input === "string" ? input : input.toString();
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const testCookie = "sessionKey=sk-test-cookie-value-12345";
    daemon.registerCredential("claude-web", testCookie);

    const isValid = await daemon.validateCredential("claude-web");
    assert.equal(isValid, true);
    assert.ok(capturedUrl, "URL should be captured");
    assert.ok(capturedHeaders, "Headers should be captured");
    assert.equal(
      capturedHeaders["Cookie"],
      testCookie,
      "Request must include Cookie: entry.value in request headers"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Test Case 2: For gemini-web, when upstream responds with Set-Cookie: __Secure-1PSIDTS=new_ts, merges rotated cookies, updates in-memory entry, and calls onRefreshed callback", async () => {
  const daemon = new AutoRefreshDaemon();
  const originalFetch = globalThis.fetch;

  const initialCookie =
    "__Secure-1PSID=sid_original_123; __Secure-1PSIDTS=ts_old_value; __Secure-1PSIDCC=cc_original_456";

  let refreshedCallbackValue: string | null = null;
  let capturedMethod: string | null = null;
  let capturedUrl: string | null = null;
  let capturedHeaders: Record<string, string> | null = null;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = typeof input === "string" ? input : input.toString();
    capturedMethod = init?.method || "GET";
    capturedHeaders = (init?.headers as Record<string, string>) || {};

    const respHeaders = new Headers();
    respHeaders.append(
      "set-cookie",
      "__Secure-1PSIDTS=ts_rotated_new_value; Domain=.google.com; Path=/; Secure; HttpOnly"
    );
    respHeaders.append(
      "set-cookie",
      "__Secure-1PSIDCC=cc_rotated_new_value; Domain=.google.com; Path=/; Secure; HttpOnly"
    );

    const resp = new Response("ok", {
      status: 200,
      headers: respHeaders,
    });
    Object.defineProperty(resp, "url", { value: "https://gemini.google.com/app" });
    return resp;
  }) as typeof fetch;

  try {
    daemon.registerCredential("gemini-web", initialCookie, async (newValue) => {
      refreshedCallbackValue = newValue;
    });

    const isValid = await daemon.validateCredential("gemini-web");

    assert.equal(isValid, true, "Credential validation should succeed");
    assert.equal(capturedMethod, "GET", "gemini-web should use GET method");
    assert.equal(
      capturedUrl,
      "https://gemini.google.com/app",
      "gemini-web should prefer https://gemini.google.com/app"
    );
    assert.equal(
      capturedHeaders?.["Cookie"],
      initialCookie,
      "Request must include Cookie header with initial cookie value"
    );

    // Verify in-memory entry is updated
    const currentCredential = daemon.getCredential("gemini-web");
    assert.ok(currentCredential, "In-memory credential should exist");
    assert.ok(
      currentCredential.includes("__Secure-1PSID=sid_original_123"),
      "Original __Secure-1PSID should be preserved"
    );
    assert.ok(
      currentCredential.includes("__Secure-1PSIDTS=ts_rotated_new_value"),
      "Rotated __Secure-1PSIDTS should be updated"
    );
    assert.ok(
      currentCredential.includes("__Secure-1PSIDCC=cc_rotated_new_value"),
      "Rotated __Secure-1PSIDCC should be updated"
    );

    // Verify callback was invoked
    assert.equal(
      refreshedCallbackValue,
      currentCredential,
      "onRefreshed callback should be invoked with the new merged cookie value"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Test Case 3: For gemini-web, when upstream redirects to accounts.google.com/ServiceLogin or returns 401/403, detects expiration and marks credential as expired", async () => {
  const daemon = new AutoRefreshDaemon();
  const originalFetch = globalThis.fetch;

  try {
    // 3a: Redirect followed - landing on accounts.google.com/ServiceLogin
    globalThis.fetch = (async () => {
      const resp = new Response("login required", { status: 200 });
      Object.defineProperty(resp, "url", {
        value:
          "https://accounts.google.com/ServiceLogin?service=chat&continue=https://gemini.google.com/app",
      });
      return resp;
    }) as typeof fetch;

    daemon.registerCredential("gemini-web", "__Secure-1PSID=expired_sid");
    const result3a = await daemon.validateCredential("gemini-web");
    assert.equal(result3a, false, "Should return false when landing on Google ServiceLogin");

    await daemon.check();
    assert.ok(
      daemon.getStatus().expiredCredentials.includes("gemini-web"),
      "daemon status should list gemini-web as expired"
    );

    // 3b: Redirect with Location header to accounts.google.com
    globalThis.fetch = (async () => {
      const respHeaders = new Headers();
      respHeaders.set("location", "https://accounts.google.com/v3/signin/identifier");
      return new Response(null, {
        status: 302,
        headers: respHeaders,
      });
    }) as typeof fetch;

    const result3b = await daemon.validateCredential("gemini-web");
    assert.equal(result3b, false, "Should return false when redirected (302) to Google login");

    // 3c: 401 Unauthorized
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const result3c = await daemon.validateCredential("gemini-web");
    assert.equal(result3c, false, "Should return false on 401");

    // 3d: 403 Forbidden
    globalThis.fetch = (async () => {
      return new Response("Forbidden", { status: 403 });
    }) as typeof fetch;

    const result3d = await daemon.validateCredential("gemini-web");
    assert.equal(result3d, false, "Should return false on 403");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Test Case 4: Other web providers continue validating with active Cookie headers without breaking", async () => {
  const daemon = new AutoRefreshDaemon();
  const originalFetch = globalThis.fetch;
  const capturedCalls: Array<{ url: string; method: string; cookie?: string }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) || {};
    capturedCalls.push({
      url,
      method: init?.method || "HEAD",
      cookie: headers["Cookie"],
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    daemon.registerCredential("grok-web", "sso=grok-cookie-token");
    daemon.registerCredential("deepseek-web", "user-token=deepseek-cookie-token");

    const grokValid = await daemon.validateCredential("grok-web");
    const deepseekValid = await daemon.validateCredential("deepseek-web");

    assert.equal(grokValid, true);
    assert.equal(deepseekValid, true);

    assert.equal(capturedCalls.length, 2);
    assert.equal(capturedCalls[0].cookie, "sso=grok-cookie-token");
    assert.equal(capturedCalls[0].method, "HEAD");
    assert.equal(capturedCalls[1].cookie, "user-token=deepseek-cookie-token");
    assert.equal(capturedCalls[1].method, "HEAD");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Test Case 5: updateCredential updates stored value and preserves onRefreshed callback", async () => {
  const daemon = new AutoRefreshDaemon();
  let callbackCount = 0;

  daemon.registerCredential("gemini-web", "cookie-1", () => {
    callbackCount++;
  });

  assert.equal(daemon.getCredential("gemini-web"), "cookie-1");

  daemon.updateCredential("gemini-web", "cookie-2");
  assert.equal(daemon.getCredential("gemini-web"), "cookie-2");
  assert.equal(
    callbackCount,
    0,
    "Callback should not be triggered simply by calling updateCredential"
  );
});
