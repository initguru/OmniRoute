import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB DATA_DIR before transitive DB imports
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gweb-timeout-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "gweb-timeout-secret";

import {
  resolveDeepThinkTimeoutMs,
} from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";
import {
  GEMINI_DEEP_THINK_TIMEOUT_CODE,
} from "../../open-sse/config/constants.ts";
import {
  checkFallbackError,
} from "../../open-sse/services/accountFallback.ts";
import {
  MAX_PROVIDER_SPECIFIC_TIMEOUT_MS,
} from "../../src/shared/validation/providerSpecificData.ts";

test("resolveDeepThinkTimeoutMs hierarchy and bounds", async (t) => {
  const originalEnv = process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS;

  t.after(() => {
    if (originalEnv === undefined) {
      delete process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS;
    } else {
      process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = originalEnv;
    }
  });

  await t.test("returns connectionTimeoutMs when finite positive number within bounds", () => {
    delete process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS;
    assert.equal(resolveDeepThinkTimeoutMs(120_000), 120_000);
    assert.equal(resolveDeepThinkTimeoutMs(45_000), 45_000);
    assert.equal(resolveDeepThinkTimeoutMs(MAX_PROVIDER_SPECIFIC_TIMEOUT_MS), MAX_PROVIDER_SPECIFIC_TIMEOUT_MS);
  });

  await t.test("clamps connectionTimeoutMs when exceeding MAX_PROVIDER_SPECIFIC_TIMEOUT_MS", () => {
    delete process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS;
    assert.equal(
      resolveDeepThinkTimeoutMs(MAX_PROVIDER_SPECIFIC_TIMEOUT_MS + 10_000),
      MAX_PROVIDER_SPECIFIC_TIMEOUT_MS
    );
  });

  await t.test("reads OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS when connectionTimeoutMs is undefined", () => {
    process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = "300000";
    assert.equal(resolveDeepThinkTimeoutMs(undefined), 300_000);

    process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = "900000";
    assert.equal(resolveDeepThinkTimeoutMs(), 900_000);
  });

  await t.test("connectionTimeoutMs takes precedence over environment variable", () => {
    process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = "900000";
    assert.equal(resolveDeepThinkTimeoutMs(150_000), 150_000);
  });

  await t.test("defaults to 600_000 (10 minutes) when neither is provided or values are invalid/negative/zero", () => {
    delete process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS;
    assert.equal(resolveDeepThinkTimeoutMs(undefined), 600_000);
    assert.equal(resolveDeepThinkTimeoutMs(), 600_000);

    // Negative / zero / NaN connectionTimeoutMs
    assert.equal(resolveDeepThinkTimeoutMs(0), 600_000);
    assert.equal(resolveDeepThinkTimeoutMs(-1000), 600_000);
    assert.equal(resolveDeepThinkTimeoutMs(Number.NaN), 600_000);

    // Invalid env values
    process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = "invalid";
    assert.equal(resolveDeepThinkTimeoutMs(undefined), 600_000);

    process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = "0";
    assert.equal(resolveDeepThinkTimeoutMs(undefined), 600_000);

    process.env.OMNIROUTE_GEMINI_WEB_DEEP_THINK_TIMEOUT_MS = "-5000";
    assert.equal(resolveDeepThinkTimeoutMs(undefined), 600_000);
  });
});

test("checkFallbackError handles GEMINI_DEEP_THINK_TIMEOUT_CODE as terminal non-fallback", () => {
  assert.equal(GEMINI_DEEP_THINK_TIMEOUT_CODE, "gemini_deep_think_timeout");

  const result = checkFallbackError(
    504,
    "Gemini web thinking phase timed out",
    0,
    "gemini-2.5-pro",
    "gemini-web",
    null,
    null,
    { code: GEMINI_DEEP_THINK_TIMEOUT_CODE }
  );

  assert.deepEqual(result, {
    shouldFallback: false,
    cooldownMs: 0,
    skipProviderBreaker: true,
    reason: GEMINI_DEEP_THINK_TIMEOUT_CODE,
  });
});
