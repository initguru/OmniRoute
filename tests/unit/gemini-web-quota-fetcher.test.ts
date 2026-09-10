import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fetchGeminiWebQuota,
  registerGeminiWebQuotaFetcher,
  clearGeminiWebQuotaCache,
  GEMINI_WEB_QUOTA_CACHE_TTL_MS,
} from "../../open-sse/services/geminiWebQuotaFetcher.ts";
import { getQuotaFetcher, getQuotaWindows } from "../../open-sse/services/quotaPreflight.ts";
import { getGeminiWebUsage } from "../../open-sse/services/usage/gemini-web.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/quota-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("Gemini Web Quota Fetcher and Usage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearGeminiWebQuotaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearGeminiWebQuotaCache();
  });

  it("should define GEMINI_WEB_QUOTA_CACHE_TTL_MS as 60000", () => {
    assert.equal(GEMINI_WEB_QUOTA_CACHE_TTL_MS, 60_000);
  });

  describe("fetchGeminiWebQuota", () => {
    it("should fetch quota and return QuotaInfo with gemini-deep-think window for valid connection", async () => {
      let requestedUrl = "";
      let requestedMethod = "";
      let requestedHeaders: Record<string, string> = {};
      let requestedBody = "";

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = url.toString();
        requestedMethod = init?.method ?? "GET";
        requestedHeaders = (init?.headers as Record<string, string>) ?? {};
        requestedBody = init?.body?.toString() ?? "";

        return new Response(fixture.quotaResponseSample, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const connection = {
        apiKey: "__Secure-1PSID=test-psid; __Secure-1PSIDTS=test-psidts",
        providerSpecificData: {
          atToken: "test-at-token",
          fSid: "test-fsid",
          buildLabel: "test-bl",
        },
      };

      const result = await fetchGeminiWebQuota("conn-1", connection);

      assert.ok(result, "QuotaInfo result should not be null");
      assert.equal(result.total, 48000);
      assert.equal(result.used, 1151);
      assert.equal(result.percentUsed, 1151 / 48000);
      const expectedResetAt = new Date(1773099955 * 1000 + 622).toISOString();
      assert.equal(result.resetAt, expectedResetAt);
      assert.equal(result.limitReached, false);

      assert.ok(result.windows?.["gemini-deep-think"]);
      assert.equal(result.windows["gemini-deep-think"].percentUsed, 1151 / 48000);
      assert.equal(result.windows["gemini-deep-think"].resetAt, expectedResetAt);

      assert.ok(requestedUrl.includes("https://gemini.google.com/_/BardChatUi/data/batchexecute"));
      assert.ok(requestedUrl.includes("rpcids=qpEbW"));
      assert.ok(requestedUrl.includes("bl=test-bl"));
      assert.ok(requestedUrl.includes("f.sid=test-fsid"));
      assert.ok(requestedUrl.includes("hl=en"));
      assert.ok(requestedUrl.includes("rt=c"));
      assert.equal(requestedMethod, "POST");
      assert.equal(requestedHeaders["x-same-domain"], "1");
      assert.ok(requestedHeaders["Cookie"]?.includes("__Secure-1PSID=test-psid"));
      assert.ok(requestedBody.includes("qpEbW"));
      assert.ok(requestedBody.includes("test-at-token"));
    });

    it("should handle exhausted quota with limitReached=true", async () => {
      globalThis.fetch = (async () => {
        return new Response(fixture.quotaResponseExhausted, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const connection = {
        apiKey: "__Secure-1PSID=test-psid",
        providerSpecificData: {
          at: "test-at-token",
          fsid: "test-fsid",
        },
      };

      const result = await fetchGeminiWebQuota("conn-exhausted", connection);
      assert.ok(result);
      assert.equal(result.total, 48000);
      assert.equal(result.used, 48000);
      assert.equal(result.percentUsed, 1.0);
      assert.equal(result.limitReached, true);
    });

    it("should return cached QuotaInfo on consecutive calls within TTL without extra fetch calls", async () => {
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount++;
        return new Response(fixture.quotaResponseSample, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const connection = {
        cookie: "__Secure-1PSID=test-psid; __Secure-1PSIDTS=test-psidts",
        providerSpecificData: {
          atToken: "test-at",
          fSid: "test-fsid",
        },
      };

      const result1 = await fetchGeminiWebQuota("conn-cache", connection);
      assert.ok(result1);
      assert.equal(fetchCount, 1);

      const result2 = await fetchGeminiWebQuota("conn-cache", connection);
      assert.ok(result2);
      assert.equal(fetchCount, 1);
      assert.deepEqual(result2, result1);

      clearGeminiWebQuotaCache("conn-cache");
      const result3 = await fetchGeminiWebQuota("conn-cache", connection);
      assert.ok(result3);
      assert.equal(fetchCount, 2);
    });

    it("should return null if cookie is missing or empty", async () => {
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount++;
        return new Response(fixture.quotaResponseSample, { status: 200 });
      }) as typeof fetch;

      assert.equal(await fetchGeminiWebQuota("conn-empty-1", {}), null);
      assert.equal(await fetchGeminiWebQuota("conn-empty-2", { apiKey: "" }), null);
      assert.equal(await fetchGeminiWebQuota("conn-empty-3", { cookie: "   " }), null);
      assert.equal(await fetchGeminiWebQuota("conn-empty-4", undefined), null);
      assert.equal(fetchCount, 0);
    });

    it("should return null when upstream fetch fails or returns non-200", async () => {
      globalThis.fetch = (async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as typeof fetch;

      const connection = {
        apiKey: "__Secure-1PSID=test-psid",
        providerSpecificData: {
          atToken: "test-at",
          fSid: "test-fsid",
        },
      };

      const result = await fetchGeminiWebQuota("conn-err", connection);
      assert.equal(result, null);
    });

    it("should bootstrap session if static session tokens are not present in providerSpecificData", async () => {
      let callCount = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        callCount++;
        const urlStr = url.toString();
        if (urlStr === "https://gemini.google.com/app") {
          return new Response(
            '<html><body><script>"SNlM0e":"bootstrapped-at","FdrFJe":"bootstrapped-fsid","cfb2h":"bootstrapped-bl"</script></body></html>',
            { status: 200 }
          );
        }
        if (urlStr.includes("batchexecute")) {
          return new Response(fixture.quotaResponseSample, { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const connection = {
        apiKey: "__Secure-1PSID=test-psid",
      };

      const result = await fetchGeminiWebQuota("conn-bootstrap", connection);
      assert.ok(result);
      assert.equal(callCount, 2); // 1 for bootstrap, 1 for batchexecute
    });
  });

  describe("registerGeminiWebQuotaFetcher", () => {
    it("should register quota fetcher and quota windows for gemini-web and gweb", () => {
      registerGeminiWebQuotaFetcher();

      const fetcherGeminiWeb = getQuotaFetcher("gemini-web");
      const fetcherGweb = getQuotaFetcher("gweb");
      assert.ok(typeof fetcherGeminiWeb === "function");
      assert.ok(typeof fetcherGweb === "function");

      const windowsGeminiWeb = getQuotaWindows("gemini-web");
      const windowsGweb = getQuotaWindows("gweb");
      assert.deepEqual(windowsGeminiWeb, ["gemini-deep-think"]);
      assert.deepEqual(windowsGweb, ["gemini-deep-think"]);
    });
  });

  describe("getGeminiWebUsage", () => {
    it("should transform QuotaInfo into GeminiWebUsageResult with plan Free and Deep Think quota", async () => {
      globalThis.fetch = (async () => {
        return new Response(fixture.quotaResponseSample, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const connection = {
        apiKey: "__Secure-1PSID=test-psid",
        providerSpecificData: {
          atToken: "test-at",
          fSid: "test-fsid",
        },
      };

      const usage = await getGeminiWebUsage("conn-usage-1", connection);

      assert.equal(usage.plan, "Free");
      assert.ok(usage.quotas?.["gemini-deep-think"]);

      const quota = usage.quotas["gemini-deep-think"];
      assert.equal(quota.used, 1151);
      assert.equal(quota.total, 48000);
      assert.equal(quota.remaining, 46849);
      assert.equal(quota.remainingPercentage, (46849 / 48000) * 100);
      const expectedResetAt = new Date(1773099955 * 1000 + 622).toISOString();
      assert.equal(quota.resetAt, expectedResetAt);
      assert.equal(quota.unlimited, false);
      assert.equal(quota.displayName, "Deep Think");
    });

    it("should return error message object when quota fetch fails", async () => {
      const usage = await getGeminiWebUsage("conn-no-cookie", {});
      assert.equal(usage.plan, undefined);
      assert.equal(usage.quotas, undefined);
      assert.equal(usage.message, "Failed to fetch Gemini Web quota");
    });
  });
});
