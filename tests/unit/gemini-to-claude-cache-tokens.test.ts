import test from "node:test";
import assert from "node:assert/strict";

const { geminiToClaudeResponse } =
  await import("../../open-sse/translator/response/gemini-to-claude.ts");

test("Gemini -> Claude stream: deducts cachedContentTokenCount from promptTokenCount for fresh input_tokens", () => {
  const state: Record<string, unknown> = {};
  const result = geminiToClaudeResponse(
    {
      responseId: "resp-cache-test",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: { parts: [{ text: "Hello from Gemini" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 10,
        cachedContentTokenCount: 950,
      },
    },
    state
  );

  // Find message_delta event which carries final usage
  const messageDelta = result.find((event: { type: string }) => event.type === "message_delta");
  assert.ok(messageDelta, "message_delta event should be emitted");
  assert.ok(messageDelta.usage, "usage should be present on message_delta");

  // input_tokens must be fresh uncached prompt tokens (1000 - 950 = 50)
  // Total prompt tokens in Claude accounting = input_tokens (50) + cache_read_input_tokens (950) = 1000
  assert.equal(
    messageDelta.usage.input_tokens,
    50,
    "input_tokens must be promptTokenCount minus cachedContentTokenCount to avoid double counting"
  );
  assert.equal(
    messageDelta.usage.cache_read_input_tokens,
    950,
    "cache_read_input_tokens must match cachedContentTokenCount"
  );
  assert.equal(
    messageDelta.usage.output_tokens,
    50,
    "output_tokens must be candidatesTokenCount + thoughtsTokenCount"
  );
});

test("Gemini -> Claude stream: when no cached tokens, input_tokens equals promptTokenCount", () => {
  const state: Record<string, unknown> = {};
  const result = geminiToClaudeResponse(
    {
      responseId: "resp-no-cache-test",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: { parts: [{ text: "No cache" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 300,
        candidatesTokenCount: 25,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: 0,
      },
    },
    state
  );

  const messageDelta = result.find((event: { type: string }) => event.type === "message_delta");
  assert.ok(messageDelta);
  assert.equal(messageDelta.usage.input_tokens, 300);
  assert.equal(messageDelta.usage.cache_read_input_tokens, undefined);
  assert.equal(messageDelta.usage.output_tokens, 25);
});

test("Gemini -> Claude stream: clamps input_tokens to 0 if cachedContentTokenCount exceeds promptTokenCount", () => {
  const state: Record<string, unknown> = {};
  const result = geminiToClaudeResponse(
    {
      responseId: "resp-overflow-cache-test",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: { parts: [{ text: "Edge case" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: 150,
      },
    },
    state
  );

  const messageDelta = result.find((event: { type: string }) => event.type === "message_delta");
  assert.ok(messageDelta);
  assert.equal(messageDelta.usage.input_tokens, 0, "input_tokens should never be negative");
  assert.equal(messageDelta.usage.cache_read_input_tokens, 150);
});
