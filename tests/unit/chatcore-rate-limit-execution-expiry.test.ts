/**
 * Regression: the rate-limit execution-expiry catch calls persistFailureUsage.
 * Keep request-format resolution (and therefore endpointPath) ahead of that
 * closure so such a failure cannot be replaced with a ReferenceError-derived 500.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../open-sse/handlers/chatCore.ts", import.meta.url),
  "utf8"
);

test("execution-expiry failure usage has endpointPath initialized before its callback", () => {
  const formatResolution = source.indexOf("const {\n    endpointPath,\n    sourceFormat,");
  const failureUsage = source.indexOf("const persistFailureUsage = (statusCode: number");
  const executionExpiryCatch = source.indexOf(
    "const localRateLimitFailure = localLimiterErrors.getClientSafeLocalRateLimitError(error);"
  );

  assert.ok(formatResolution >= 0, "chatCore must resolve endpointPath");
  assert.ok(failureUsage >= 0, "chatCore must retain failure usage recording");
  assert.ok(executionExpiryCatch >= 0, "chatCore must classify execution expiry");
  assert.ok(
    formatResolution < failureUsage,
    "endpointPath must be initialized before the failure callback can close over it"
  );
  assert.ok(
    failureUsage < executionExpiryCatch,
    "the failure callback must remain in scope for rate-limit execution expiry handling"
  );
});
