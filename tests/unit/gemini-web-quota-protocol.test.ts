import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildDeepThinkQuotaRequestBody,
  parseDeepThinkQuotaResponse,
} from "../../open-sse/executors/gemini-web/quotaProtocol.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/quota-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("Gemini Web Quota Protocol (qpEbW)", () => {
  describe("buildDeepThinkQuotaRequestBody", () => {
    it("should build URLSearchParams with correct f.req structure and at token", () => {
      const atToken = "test-at-token-abc";
      const params = buildDeepThinkQuotaRequestBody(atToken);

      assert.ok(params instanceof URLSearchParams);
      assert.equal(params.get("at"), atToken);

      const fReqStr = params.get("f.req");
      assert.ok(fReqStr, "f.req must be present");

      const parsed = JSON.parse(fReqStr);
      assert.deepEqual(parsed, [[["qpEbW", "[[[1,4],[6,6],[1,15]]]", null, "generic"]]]);
    });
  });

  describe("parseDeepThinkQuotaResponse", () => {
    it("should parse quotaResponseSample accurately with active remaining quota", () => {
      const result = parseDeepThinkQuotaResponse(fixture.quotaResponseSample);
      assert.ok(result, "Result should not be null");

      const expectedTotal = 48000;
      const expectedRemaining = 46849;
      const expectedUsed = 1151;
      const expectedPercentUsed = 1151 / 48000;
      const expectedResetAt = new Date(1773099955 * 1000 + 622).toISOString();

      assert.equal(result.total, expectedTotal);
      assert.equal(result.remaining, expectedRemaining);
      assert.equal(result.used, expectedUsed);
      assert.equal(result.percentUsed, expectedPercentUsed);
      assert.equal(result.resetAt, expectedResetAt);
    });

    it("should parse quotaResponseExhausted with remaining=0, used=total, percentUsed=1.0", () => {
      const result = parseDeepThinkQuotaResponse(fixture.quotaResponseExhausted);
      assert.ok(result, "Result should not be null");

      assert.equal(result.total, 48000);
      assert.equal(result.remaining, 0);
      assert.equal(result.used, 48000);
      assert.equal(result.percentUsed, 1.0);
      const expectedResetAt = new Date(1773099955 * 1000 + 622).toISOString();
      assert.equal(result.resetAt, expectedResetAt);
    });

    it("should return null for empty string or invalid input", () => {
      assert.equal(parseDeepThinkQuotaResponse(""), null);
      assert.equal(parseDeepThinkQuotaResponse("invalid string"), null);
      assert.equal(parseDeepThinkQuotaResponse(")]}'\n123\n"), null);
    });

    it("should return null if envelope does not contain qpEbW rpc item", () => {
      const otherEnvelope = ')]}\'\n123\n[[["wrb.fr","other",null]]]\n';
      assert.equal(parseDeepThinkQuotaResponse(otherEnvelope), null);
    });

    it("should return null if inner JSON is malformed or missing quota tuple", () => {
      const malformedJson = ')]}\'\n123\n[[["wrb.fr","qpEbW","not-valid-json"]]]\n';
      assert.equal(parseDeepThinkQuotaResponse(malformedJson), null);

      const missingTuple = ')]}\'\n123\n[[["wrb.fr","qpEbW","[]"]]]\n';
      assert.equal(parseDeepThinkQuotaResponse(missingTuple), null);
    });

    it("should handle missing or invalid reset timestamp gracefully with resetAt: null", () => {
      const inner = JSON.stringify([[[[null, 4], 2, 1, null, 10000, 5000]], "797f3d0293f288ad"]);
      const env =
        ")]}'\n123\n" + JSON.stringify([[["wrb.fr", "qpEbW", inner, null, null, null, "generic"]]]);
      const res = parseDeepThinkQuotaResponse(env);
      assert.ok(res);
      assert.equal(res.total, 10000);
      assert.equal(res.remaining, 5000);
      assert.equal(res.used, 5000);
      assert.equal(res.percentUsed, 0.5);
      assert.equal(res.resetAt, null);
    });
  });
});
