import test from "node:test";
import assert from "node:assert/strict";
import {
  hasTerminalMarker,
  canAttemptContinuation,
  createRecoverableStream,
} from "../../open-sse/services/streamRecovery.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function makeStream(chunks: string[], end: "close" | Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc(chunks[i++]));
        return;
      }
      if (end instanceof Error) controller.error(end);
      else controller.close();
    },
  });
}

async function readAll(
  rs: ReadableStream<Uint8Array>
): Promise<{ text: string; errored: Error | null }> {
  const reader = rs.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += dec.decode(value, { stream: true });
    }
    return { text, errored: null };
  } catch (e) {
    return { text, errored: e as Error };
  }
}

test("hasTerminalMarker detects Gemini/Antigravity finishReason markers", () => {
  // Gemini / Antigravity markers
  assert.equal(
    hasTerminalMarker(enc('data: {"candidates":[{"finishReason":"STOP"}]}\n\n')),
    true,
    "should detect finishReason: STOP"
  );
  assert.equal(
    hasTerminalMarker(enc('data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n\n')),
    true,
    "should detect finishReason: MAX_TOKENS"
  );
  assert.equal(
    hasTerminalMarker(enc('data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n')),
    true,
    "should detect finishReason: SAFETY"
  );
  assert.equal(
    hasTerminalMarker(enc('data: {"FINISH_REASON":"STOP"}\n\n')),
    true,
    "should detect uppercase FINISH_REASON"
  );

  // Incomplete stream chunk without finishReason or other terminal markers
  assert.equal(
    hasTerminalMarker(enc('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n')),
    false,
    "should return false for incomplete chunk without finishReason"
  );

  // Existing terminal markers still work
  assert.equal(
    hasTerminalMarker(enc("data: [DONE]\n\n")),
    true,
    "should detect OpenAI [DONE]"
  );
  assert.equal(
    hasTerminalMarker(enc('event: message_stop\ndata: {"type":"message_stop"}\n\n')),
    true,
    "should detect Anthropic message_stop"
  );

  // Empty / null bytes
  assert.equal(hasTerminalMarker(new Uint8Array(0)), false);
  assert.equal(hasTerminalMarker(null as unknown as Uint8Array), false);
});

test("createRecoverableStream passes clean short Antigravity stream straight through without retry", async () => {
  let reopened = 0;
  let finalizeCount = 0;
  const geminiChunk = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n';
  const cleanAntigravityStream = makeStream([geminiChunk], "close");

  const rs = createRecoverableStream(
    cleanAntigravityStream,
    async () => {
      reopened++;
      return null;
    },
    {
      provider: "antigravity",
      finalize: () => finalizeCount++,
      now: () => 0,
    }
  );

  const { text, errored } = await readAll(rs);
  assert.equal(errored, null);
  assert.equal(reopened, 0, "clean antigravity stream must not trigger recovery");
  assert.equal(text, geminiChunk);
  assert.equal(finalizeCount, 1);
});

test("createRecoverableStream retries incomplete Antigravity stream when missing terminal marker", async () => {
  let reopened = 0;
  let finalizeCount = 0;
  const incompleteChunk = 'data: {"candidates":[{"content":{"parts":[{"text":"Incomplete..."}]}}]}\n\n';
  const completedChunk = 'data: {"candidates":[{"content":{"parts":[{"text":"Incomplete... done"}]},"finishReason":"STOP"}]}\n\n';
  const incompleteStream = makeStream([incompleteChunk], "close");
  const recoveredStream = makeStream([completedChunk], "close");

  const rs = createRecoverableStream(
    incompleteStream,
    async () => {
      reopened++;
      return recoveredStream;
    },
    {
      provider: "antigravity",
      finalize: () => finalizeCount++,
      now: () => 0,
    }
  );

  const { text, errored } = await readAll(rs);
  assert.equal(errored, null);
  assert.equal(reopened, 1, "incomplete stream without terminal marker should be retried");
  assert.equal(text, completedChunk);
  assert.equal(finalizeCount, 1);
});

test("canAttemptContinuation and streamRecovery respect Antigravity safeguards", () => {
  assert.equal(canAttemptContinuation("antigravity"), false);
  assert.equal(canAttemptContinuation("agy"), false);
  assert.equal(canAttemptContinuation("Antigravity"), false);
  assert.equal(canAttemptContinuation("AGY"), false);
  assert.equal(canAttemptContinuation("openai"), true);
  assert.equal(canAttemptContinuation("anthropic"), true);
});
