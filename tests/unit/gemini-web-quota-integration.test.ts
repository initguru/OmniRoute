import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { USAGE_FETCHER_PROVIDERS as USAGE_FETCHER_PROVIDERS_LEAF } from "../../open-sse/services/usage/fetcherProviders.ts";
import { USAGE_FETCHER_PROVIDERS, getUsageForProvider } from "../../open-sse/services/usage.ts";
import { USAGE_SUPPORTED_PROVIDERS } from "../../open-sse/services/usage/supportedProviders.ts";
// Importing quotaTrackersBatch triggers startup registration
import "../../open-sse/services/quotaTrackersBatch.ts";
import {
  getQuotaFetcher,
  getAllProviderQuotaWindows,
} from "../../open-sse/services/quotaPreflight.ts";
import { clearGeminiWebQuotaCache } from "../../open-sse/services/geminiWebQuotaFetcher.ts";
import {
  PROVIDER_LIMITS_APIKEY_PROVIDERS,
  isSupportedUsageConnection,
} from "../../src/lib/usage/providerLimits.ts";
import {
  PROVIDER_COLUMNS,
  getProviderColumns,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/providerColumns.ts";
import {
  PROVIDER_LABEL,
  PROVIDER_ORDER,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/constants.ts";
import type { GeminiWebUsageResult } from "../../open-sse/services/usage/gemini-web.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/quota-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("Gemini Web Quota & Provider Limits Integration", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearGeminiWebQuotaCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearGeminiWebQuotaCache();
  });

  it("includes gemini-web and gweb in USAGE_FETCHER_PROVIDERS (both leaf and usage.ts re-export)", () => {
    assert.ok(
      (USAGE_FETCHER_PROVIDERS_LEAF as readonly string[]).includes("gemini-web"),
      "USAGE_FETCHER_PROVIDERS_LEAF must include gemini-web"
    );
    assert.ok(
      (USAGE_FETCHER_PROVIDERS_LEAF as readonly string[]).includes("gweb"),
      "USAGE_FETCHER_PROVIDERS_LEAF must include gweb"
    );
    assert.ok(
      (USAGE_FETCHER_PROVIDERS as readonly string[]).includes("gemini-web"),
      "USAGE_FETCHER_PROVIDERS must include gemini-web"
    );
    assert.ok(
      (USAGE_FETCHER_PROVIDERS as readonly string[]).includes("gweb"),
      "USAGE_FETCHER_PROVIDERS must include gweb"
    );
  });

  it("includes gemini-web and gweb in USAGE_SUPPORTED_PROVIDERS", () => {
    assert.ok(
      USAGE_SUPPORTED_PROVIDERS.includes("gemini-web"),
      "USAGE_SUPPORTED_PROVIDERS must include gemini-web"
    );
    assert.ok(
      USAGE_SUPPORTED_PROVIDERS.includes("gweb"),
      "USAGE_SUPPORTED_PROVIDERS must include gweb"
    );
  });

  it("registers quota fetchers for gemini-web and gweb via quotaTrackersBatch", () => {
    const fetcherGeminiWeb = getQuotaFetcher("gemini-web");
    const fetcherGweb = getQuotaFetcher("gweb");
    assert.equal(
      typeof fetcherGeminiWeb,
      "function",
      "getQuotaFetcher('gemini-web') must be a registered function"
    );
    assert.equal(
      typeof fetcherGweb,
      "function",
      "getQuotaFetcher('gweb') must be a registered function"
    );
  });

  it("registers gemini-deep-think window in getAllProviderQuotaWindows for gemini-web and gweb", () => {
    const allWindows = getAllProviderQuotaWindows();
    assert.ok(
      allWindows["gemini-web"]?.includes("gemini-deep-think"),
      "getAllProviderQuotaWindows()['gemini-web'] must include gemini-deep-think"
    );
    assert.ok(
      allWindows["gweb"]?.includes("gemini-deep-think"),
      "getAllProviderQuotaWindows()['gweb'] must include gemini-deep-think"
    );
  });

  it("includes gemini-web and gweb in PROVIDER_LIMITS_APIKEY_PROVIDERS and accepts apikey connections", () => {
    assert.ok(
      PROVIDER_LIMITS_APIKEY_PROVIDERS.has("gemini-web"),
      "PROVIDER_LIMITS_APIKEY_PROVIDERS must have gemini-web"
    );
    assert.ok(
      PROVIDER_LIMITS_APIKEY_PROVIDERS.has("gweb"),
      "PROVIDER_LIMITS_APIKEY_PROVIDERS must have gweb"
    );

    assert.equal(
      isSupportedUsageConnection({
        id: "conn-gw",
        provider: "gemini-web",
        authType: "apikey",
      }),
      true,
      "isSupportedUsageConnection must accept gemini-web apikey connection"
    );
    assert.equal(
      isSupportedUsageConnection({
        id: "conn-gweb",
        provider: "gweb",
        authType: "apikey",
      }),
      true,
      "isSupportedUsageConnection must accept gweb apikey connection"
    );
  });

  it("configures dashboard provider columns for gemini-web and gweb", () => {
    assert.deepEqual(PROVIDER_COLUMNS["gemini-web"], ["gemini-deep-think"]);
    assert.deepEqual(PROVIDER_COLUMNS["gweb"], ["gemini-deep-think"]);

    const resolved = getProviderColumns("gemini-web", [
      { name: "gemini-deep-think", used: 10, total: 100, remaining: 90 },
    ]);
    assert.equal(resolved.columns.length, 1);
    assert.equal(resolved.columns[0].key, "gemini-deep-think");
    assert.ok(resolved.columns[0].quota);
  });

  it("configures dashboard provider label and order constants for gemini-web and gweb", () => {
    assert.equal(PROVIDER_LABEL["gemini-web"], "Gemini Web");
    assert.equal(PROVIDER_LABEL["gweb"], "Gemini Web");
    assert.equal(PROVIDER_ORDER["gemini-web"], 19);
    assert.equal(PROVIDER_ORDER["gweb"], 19);
  });

  describe("getUsageForProvider routing", () => {
    it("routes gemini-web and gweb to getGeminiWebUsage returning formatted quota", async () => {
      globalThis.fetch = (async () => {
        return new Response(fixture.quotaResponseSample, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const connectionBase = {
        apiKey: "__Secure-1PSID=test-psid; __Secure-1PSIDTS=test-psidts",
        providerSpecificData: {
          atToken: "test-at-token",
          fSid: "test-fsid",
          buildLabel: "test-bl",
        },
      };

      // Test gemini-web
      const resultGw = (await getUsageForProvider({
        id: "conn-gw-1",
        provider: "gemini-web",
        ...connectionBase,
      })) as GeminiWebUsageResult;

      assert.equal(resultGw.plan, "Free");
      assert.ok(resultGw.quotas?.["gemini-deep-think"]);
      assert.equal(resultGw.quotas["gemini-deep-think"].used, 1151);
      assert.equal(resultGw.quotas["gemini-deep-think"].total, 48000);
      assert.equal(resultGw.quotas["gemini-deep-think"].remaining, 46849);
      assert.equal(resultGw.quotas["gemini-deep-think"].displayName, "Deep Think");

      // Test gweb alias
      clearGeminiWebQuotaCache();
      const resultGweb = (await getUsageForProvider({
        id: "conn-gweb-1",
        provider: "gweb",
        ...connectionBase,
      })) as GeminiWebUsageResult;

      assert.equal(resultGweb.plan, "Free");
      assert.ok(resultGweb.quotas?.["gemini-deep-think"]);
      assert.equal(resultGweb.quotas["gemini-deep-think"].used, 1151);
      assert.equal(resultGweb.quotas["gemini-deep-think"].total, 48000);
      assert.equal(resultGweb.quotas["gemini-deep-think"].remaining, 46849);
      assert.equal(resultGweb.quotas["gemini-deep-think"].displayName, "Deep Think");
    });

    it("returns error message when gemini-web fetch fails", async () => {
      globalThis.fetch = (async () => {
        return new Response("Unauthorized", { status: 401 });
      }) as typeof fetch;

      const result = (await getUsageForProvider({
        id: "conn-gw-err",
        provider: "gemini-web",
        apiKey: "__Secure-1PSID=bad-psid",
        providerSpecificData: {
          atToken: "at",
          fSid: "fsid",
          buildLabel: "bl",
        },
      })) as { message?: string };

      assert.equal(result.message, "Failed to fetch Gemini Web quota");
    });
  });
});
