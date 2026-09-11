import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GEMINI_DEEP_THINK_MODEL_ID,
  buildModelHeaders,
  buildStreamGenerateBody,
  parseStreamGenerateEnvelope,
  buildPollRequestBody,
  parsePollResponse,
  bootstrapGeminiWebSession,
} from "../../open-sse/executors/gemini-web/directProtocol.ts";

const fixturePath = fileURLToPath(
  new URL("../fixtures/gemini-web/deep-think-observed-wire.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("Gemini Web Direct Protocol", () => {
  describe("buildModelHeaders", () => {
    it("should build default headers with GEMINI_DEEP_THINK_MODEL_ID and valid structure", () => {
      const headers = buildModelHeaders();
      assert.equal(headers["x-same-domain"], "1");
      assert.equal(headers["x-goog-ext-73010989-jspb"], "[0]");
      assert.equal(headers["x-goog-ext-73010990-jspb"], "[0,0,0]");

      const parsed525 = JSON.parse(headers["x-goog-ext-525001261-jspb"]);
      assert.equal(parsed525[0], 1);
      assert.equal(parsed525[4], GEMINI_DEEP_THINK_MODEL_ID);
      assert.deepEqual(parsed525[8], [4, 5, 6, 8, 4, 5, 6, 8]);
      assert.ok(typeof parsed525[16] === "string" && parsed525[16].length > 0);
    });

    it("should allow custom modelId and clientUuid", () => {
      const customModel = "custom_hash_123";
      const customUuid = "11111111-2222-3333-4444-555555555555";
      const headers = buildModelHeaders(customModel, customUuid);

      const parsed525 = JSON.parse(headers["x-goog-ext-525001261-jspb"]);
      assert.equal(parsed525[4], customModel);
      assert.equal(parsed525[16], customUuid);
    });
  });

  describe("buildStreamGenerateBody", () => {
    it("should construct URLSearchParams with slot 0 prompt, slot 17 [[0]], and slot 1 ['en']", () => {
      const prompt = "Solve this puzzle";
      const params = buildStreamGenerateBody(prompt, {
        sessionId: "test-session-uuid",
        atToken: "test-at-token",
      });

      assert.equal(params.get("at"), "test-at-token");
      const fReqStr = params.get("f.req");
      assert.ok(fReqStr, "f.req must exist");

      const fReq = JSON.parse(fReqStr);
      assert.equal(fReq[0], null);
      const innerArray = JSON.parse(fReq[1]);

      assert.equal(innerArray.length, 99);
      assert.deepEqual(innerArray[0], [prompt, 0, null, null, null, null, 0]);
      assert.deepEqual(innerArray[1], ["en"]);
      assert.deepEqual(innerArray[17], [[0]]);
      assert.equal(innerArray[59], "test-session-uuid");
      assert.equal(innerArray[4], "5332ff0c5c851ad12a167845399b8da1");
    });

    it("should include contextToken in slot 3 when provided", () => {
      const prompt = "Follow-up turn";
      const contextToken = "!c3ClcContextTokenExample...";
      const params = buildStreamGenerateBody(prompt, { contextToken });

      const fReq = JSON.parse(params.get("f.req")!);
      const innerArray = JSON.parse(fReq[1]);
      assert.equal(innerArray[3], contextToken);
    });
  });

  describe("parseStreamGenerateEnvelope", () => {
    it("should parse initial envelope fixture and extract conversationId, responseId, and isPending", () => {
      const result = parseStreamGenerateEnvelope(fixture.streamGenerateInitialResponse);
      assert.equal(result.conversationId, "c_redacted_test_conv_001");
      assert.equal(result.responseId, "r_redacted_test_resp_001");
      assert.equal(result.isPending, true);
      assert.ok(result.initialText?.includes("Responses with Deep Think can take some time"));
    });

    it("should handle empty or malformed envelope gracefully", () => {
      const result = parseStreamGenerateEnvelope("invalid non-json text");
      assert.equal(result.isPending, false);
      assert.ok(result.error);
    });
  });

  describe("buildPollRequestBody", () => {
    it("should format hNvQHb batchexecute RPC payload with conversationId and atToken", () => {
      const convId = "c_91986748cb5d1174";
      const atToken = "AOvx0lTestToken:123456";
      const params = buildPollRequestBody(convId, atToken);

      assert.equal(params.get("at"), atToken);
      const fReqStr = params.get("f.req");
      assert.ok(fReqStr);

      const fReq = JSON.parse(fReqStr);
      assert.equal(fReq.length, 1);
      assert.equal(fReq[0].length, 1);

      const [rpcId, rpcArg, nullVal, mode] = fReq[0][0];
      assert.equal(rpcId, "hNvQHb");
      assert.equal(nullVal, null);
      assert.equal(mode, "generic");

      const parsedArg = JSON.parse(rpcArg);
      assert.equal(parsedArg[0], convId);
      assert.equal(parsedArg[1], 10);
      assert.deepEqual(parsedArg[4], [1]);
      assert.deepEqual(parsedArg[5], [4]);
    });
  });

  describe("parsePollResponse", () => {
    it("should parse pending poll response fixture with isPending: true", () => {
      const result = parsePollResponse(fixture.pollPendingResponse);
      assert.equal(result.isPending, true);
      assert.equal(result.isFailed, false);
      assert.ok(result.thoughts?.includes("Defining the Goal"));
    });

    it("should parse completed poll response fixture with isPending: false and extract text and thoughts", () => {
      const result = parsePollResponse(fixture.pollCompletedResponse);
      assert.equal(result.isPending, false);
      assert.equal(result.isFailed, false);
      assert.equal(result.text, "Paris");
      assert.ok(result.thoughts?.includes("Defining the Goal"));
    });

    it("should detect failure when poll status indicates error or failure text is returned", () => {
      const result = parsePollResponse(fixture.pollFailedResponse);
      assert.equal(result.isPending, false);
      assert.equal(result.isFailed, true);
      assert.ok(result.error || result.text?.includes("wasn't able to finish thinking"));
    });

    it("should handle malformed poll response", () => {
      const result = parsePollResponse(")]}'\nnot json");
      assert.equal(result.isPending, false);
      assert.equal(result.isFailed, true);
      assert.ok(result.error);
    });
  });

  describe("bootstrapGeminiWebSession", () => {
    it("should extract atToken (SNlM0e), fSid (FdrFJe), and buildLabel (cfb2h) from HTML", async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script>
            window.WIZ_global_data = {
              "SNlM0e": "AOvx0lMockAtToken:1789047456",
              "FdrFJe": "-7998873305294431664",
              "cfb2h": "boq_assistant-bard-web-server_20260907.07_p0"
            };
          </script>
        </head>
        <body></body>
        </html>
      `;

      const mockFetch = mock.fn(async () => {
        return new Response(mockHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      });

      const session = await bootstrapGeminiWebSession(
        "__Secure-1PSID=mock; __Secure-1PSIDTS=mock",
        undefined,
        {
          fetchFn: mockFetch as unknown as typeof fetch,
        }
      );

      assert.equal(session.atToken, "AOvx0lMockAtToken:1789047456");
      assert.equal(session.fSid, "-7998873305294431664");
      assert.equal(session.buildLabel, "boq_assistant-bard-web-server_20260907.07_p0");
      assert.equal(mockFetch.mock.callCount(), 1);
    });

    it("should extract tokens and return mergedCookie when Set-Cookie headers are present in bootstrap response", async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script>
            window.WIZ_global_data = {
              "SNlM0e": "AOvx0lMockAtToken:1789047456",
              "FdrFJe": "-7998873305294431664",
              "cfb2h": "boq_assistant-bard-web-server_20260907.07_p0"
            };
          </script>
        </head>
        <body></body>
        </html>
      `;

      const headers = new Headers();
      headers.set("content-type", "text/html");
      headers.append("set-cookie", "__Secure-1PSIDTS=new_ts_123; Path=/; Domain=.google.com");

      const mockFetch = mock.fn(async () => {
        return new Response(mockHtml, {
          status: 200,
          headers,
        });
      });

      const initialCookie = "__Secure-1PSID=sid_val; __Secure-1PSIDTS=old_ts_val";
      const session = await bootstrapGeminiWebSession(initialCookie, undefined, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      assert.equal(session.atToken, "AOvx0lMockAtToken:1789047456");
      assert.equal(session.fSid, "-7998873305294431664");
      assert.equal(session.buildLabel, "boq_assistant-bard-web-server_20260907.07_p0");
      assert.ok(session.mergedCookie, "mergedCookie should be defined");
      assert.ok(session.mergedCookie.includes("__Secure-1PSIDTS=new_ts_123"));
      assert.ok(session.mergedCookie.includes("__Secure-1PSID=sid_val"));
    });

    it("should throw when HTML is missing required tokens (e.g. unauthenticated)", async () => {
      const mockHtml = `<html><body><a href="https://accounts.google.com/signin">Sign in</a></body></html>`;
      const mockFetch = mock.fn(async () => {
        return new Response(mockHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      });

      await assert.rejects(
        async () => {
          await bootstrapGeminiWebSession("invalid_cookie", undefined, {
            fetchFn: mockFetch as unknown as typeof fetch,
          });
        },
        {
          message: /Failed to extract Gemini Web session tokens/,
        }
      );
    });

    it("should throw when response URL or redirect indicates Google login page", async () => {
      const mockFetch = mock.fn(async () => {
        const resp = new Response("<html>Login required</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        Object.defineProperty(resp, "url", {
          value:
            "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fgemini.google.com%2Fapp",
        });
        return resp;
      });

      await assert.rejects(
        async () => {
          await bootstrapGeminiWebSession("__Secure-1PSID=expired", undefined, {
            fetchFn: mockFetch as unknown as typeof fetch,
          });
        },
        {
          message: /Failed to extract Gemini Web session tokens/,
        }
      );
    });
  });
});
