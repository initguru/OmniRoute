import test from "node:test";
import assert from "node:assert/strict";

import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

async function pumpStream(
  transform: ReturnType<typeof createSSETransformStreamWithLogger>,
  chunks: string[]
): Promise<string> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let output = "";
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  })();

  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await readPromise;
  return output;
}

test("Gemini stream log classification: separates thought into accumulatedReasoning for Antigravity format", async () => {
  let completedPayload: Record<string, unknown> | null = null;

  const transform = createSSETransformStreamWithLogger(
    FORMATS.ANTIGRAVITY,
    FORMATS.CLAUDE,
    "antigravity",
    null,
    null,
    "gemini-3.8-flash-high",
    "conn-test",
    { stream: true },
    (payload) => {
      completedPayload = payload as unknown as Record<string, unknown>;
    }
  );

  const chunks = [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: "THOUGHT_SENTINEL" }],
            },
          },
        ],
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: "ANSWER_SENTINEL" }],
            },
            finishReason: "STOP",
          },
        ],
      },
    })}\n\n`,
  ];

  await pumpStream(transform, chunks);

  assert.ok(completedPayload, "onComplete callback must be invoked");
  const responseBody = (completedPayload as Record<string, unknown>).responseBody as Record<
    string,
    unknown
  >;
  assert.ok(responseBody, "responseBody must exist");
  const choices = responseBody.choices as Array<{ message: Record<string, unknown> }>;
  assert.ok(choices && choices.length > 0, "choices array must exist");
  const message = choices[0].message;

  assert.equal(
    message.content,
    "ANSWER_SENTINEL",
    "message.content must contain only non-thought text"
  );
  assert.equal(
    message.reasoning_content,
    "THOUGHT_SENTINEL",
    "message.reasoning_content must contain thought text"
  );
});

test("Gemini stream log classification: separates thought for bare Gemini format", async () => {
  let completedPayload: Record<string, unknown> | null = null;

  const transform = createSSETransformStreamWithLogger(
    FORMATS.GEMINI,
    FORMATS.CLAUDE,
    "gemini",
    null,
    null,
    "gemini-2.5-flash",
    "conn-test-gemini",
    { stream: true },
    (payload) => {
      completedPayload = payload as unknown as Record<string, unknown>;
    }
  );

  const chunks = [
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ thought: true, text: "BARE_THOUGHT_REASONING" }],
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: "BARE_FINAL_ANSWER" }],
          },
          finishReason: "STOP",
        },
      ],
    })}\n\n`,
  ];

  await pumpStream(transform, chunks);

  assert.ok(completedPayload, "onComplete callback must be invoked");
  const responseBody = (completedPayload as Record<string, unknown>).responseBody as Record<
    string,
    unknown
  >;
  const choices = responseBody.choices as Array<{ message: Record<string, unknown> }>;
  const message = choices[0].message;

  assert.equal(
    message.content,
    "BARE_FINAL_ANSWER",
    "message.content must contain only non-thought text"
  );
  assert.equal(
    message.reasoning_content,
    "BARE_THOUGHT_REASONING",
    "message.reasoning_content must contain thought text"
  );
});

test("Gemini stream log classification: preserves signed non-thought text in accumulatedContent", async () => {
  let completedPayload: Record<string, unknown> | null = null;

  const transform = createSSETransformStreamWithLogger(
    FORMATS.ANTIGRAVITY,
    FORMATS.CLAUDE,
    "antigravity",
    null,
    null,
    "gemini-3.8-flash-high",
    "conn-test-signed",
    { stream: true },
    (payload) => {
      completedPayload = payload as unknown as Record<string, unknown>;
    }
  );

  const chunks = [
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: "PLANNING_STAGE" }],
            },
          },
        ],
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: false,
                  thoughtSignature: "opaque-sig-12345",
                  text: "SIGNED_ANSWER_PREFIX",
                },
                {
                  text: " AND_REST_OF_ANSWER",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    })}\n\n`,
  ];

  await pumpStream(transform, chunks);

  assert.ok(completedPayload, "onComplete callback must be invoked");
  const responseBody = (completedPayload as Record<string, unknown>).responseBody as Record<
    string,
    unknown
  >;
  const choices = responseBody.choices as Array<{ message: Record<string, unknown> }>;
  const message = choices[0].message;

  assert.equal(
    message.content,
    "SIGNED_ANSWER_PREFIX AND_REST_OF_ANSWER",
    "message.content must preserve signed and unsigned non-thought text"
  );
  assert.equal(
    message.reasoning_content,
    "PLANNING_STAGE",
    "message.reasoning_content must contain only thought: true text"
  );
});
