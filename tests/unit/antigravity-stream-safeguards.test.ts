import test from "node:test";
import assert from "node:assert/strict";
import {
  canAttemptContinuation,
  createRecoverableStream,
  TruncatedStreamError,
} from "../../open-sse/services/streamRecovery.ts";
import { geminiToClaudeResponse } from "../../open-sse/translator/response/gemini-to-claude.ts";
import {
  processAntigravitySSEPayload,
  type AntigravityCollectedStream,
} from "../../open-sse/executors/antigravity/sseCollect.ts";

function createEmptyCollectedStream(): AntigravityCollectedStream {
  return {
    textContent: "",
    finishReason: "",
    toolCalls: [],
    usage: null,
    remainingCredits: null,
  };
}

test("canAttemptContinuation rejects antigravity and agy providers", () => {
  assert.equal(canAttemptContinuation("antigravity"), false);
  assert.equal(canAttemptContinuation("agy"), false);
  assert.equal(canAttemptContinuation("Antigravity"), false);
  assert.equal(canAttemptContinuation("AGY"), false);
  assert.equal(canAttemptContinuation(" antigravity "), false);
  assert.equal(canAttemptContinuation({ provider: "antigravity" }), false);
  assert.equal(canAttemptContinuation({ provider: "agy" }), false);

  assert.equal(canAttemptContinuation("openai"), true);
  assert.equal(canAttemptContinuation("anthropic"), true);
  assert.equal(canAttemptContinuation(null), true);
  assert.equal(canAttemptContinuation(undefined), true);
});

test("createRecoverableStream suppresses continueStream when provider is antigravity or agy", async () => {
  let continueCalled = false;
  const encoder = new TextEncoder();

  // Create an initial stream that emits committed bytes then encounters a retryable truncation error
  let pulled = false;
  const initialStream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        // Emit enough bytes to immediately commit holdback (BUFFER_MAX_BYTES is 4096)
        const largeText = "x".repeat(5000);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: largeText } }] })}\n\n`)
        );
      } else {
        controller.error(new TruncatedStreamError());
      }
    },
  });

  const recoverable = createRecoverableStream(
    initialStream,
    async () => null,
    {
      finalize: () => {},
      provider: "antigravity",
      continueStream: async () => {
        continueCalled = true;
        return null;
      },
    }
  );

  const reader = recoverable.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Expected to error on truncation because continuation is disabled
  }

  assert.equal(continueCalled, false, "continueStream must not be called for antigravity provider");
});

test("geminiToClaudeResponse detects mid-stream error envelope and populates state.upstreamError", () => {
  const state: Record<string, unknown> = {};
  const errorChunk = {
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      status: "RESOURCE_EXHAUSTED",
    },
  };

  const result = geminiToClaudeResponse(errorChunk, state);
  assert.equal(result, null);
  assert.ok(state.upstreamError, "state.upstreamError should be populated");
  const err = state.upstreamError as { status: number; type: string; code: string; message: string };
  assert.equal(err.status, 429);
  assert.equal(err.type, "rate_limit_error");
  assert.equal(err.code, "RESOURCE_EXHAUSTED");
  assert.equal(err.message, "Resource has been exhausted (e.g. check quota).");
});

test("geminiToClaudeResponse detects nested response.error envelope", () => {
  const state: Record<string, unknown> = {};
  const errorChunk = {
    response: {
      error: {
        code: 503,
        message: "The model is overloaded. Please try again later.",
        status: "UNAVAILABLE",
      },
    },
  };

  const result = geminiToClaudeResponse(errorChunk, state);
  assert.equal(result, null);
  assert.ok(state.upstreamError, "state.upstreamError should be populated");
  const err = state.upstreamError as { status: number; type: string; code: string; message: string };
  assert.equal(err.status, 503);
  assert.equal(err.type, "server_error");
  assert.equal(err.code, "UNAVAILABLE");
  assert.equal(err.message, "The model is overloaded. Please try again later.");
});

test("processAntigravitySSEPayload detects payload.error, sets collected.error, and throws", () => {
  const collected = createEmptyCollectedStream();
  const payload = JSON.stringify({
    error: {
      code: 429,
      message: "Quota exceeded for quota metric 'GenerateContent'",
      status: "RESOURCE_EXHAUSTED",
    },
  });

  assert.throws(
    () => {
      processAntigravitySSEPayload(payload, collected);
    },
    (err: unknown) => {
      assert.match((err as Error).message, /Quota exceeded/);
      return true;
    }
  );

  assert.ok(collected.error, "collected.error should be populated");
  const errObj = collected.error as { code?: number; status?: string };
  assert.equal(errObj.code, 429);
  assert.equal(errObj.status, "RESOURCE_EXHAUSTED");
});

test("processAntigravitySSEPayload detects payload.response.error, sets collected.error, and throws", () => {
  const collected = createEmptyCollectedStream();
  const payload = JSON.stringify({
    response: {
      error: {
        code: 500,
        message: "Internal server error occurred.",
        status: "INTERNAL",
      },
    },
  });

  assert.throws(
    () => {
      processAntigravitySSEPayload(payload, collected);
    },
    (err: unknown) => {
      assert.match((err as Error).message, /Internal server error/);
      return true;
    }
  );

  assert.ok(collected.error, "collected.error should be populated");
  const errObj = collected.error as { code?: number };
  assert.equal(errObj.code, 500);
});
