import test from "node:test";
import assert from "node:assert/strict";

const { geminiToClaudeResponse } =
  await import("../../open-sse/translator/response/gemini-to-claude.ts");

function flatten(items: (unknown[] | null)[]): Record<string, unknown>[] {
  return items.flatMap((item) => (item as Record<string, unknown>[]) || []);
}

function getTextDeltas(events: Record<string, unknown>[]): string[] {
  return events
    .filter(
      (e) =>
        e?.type === "content_block_delta" &&
        (e.delta as Record<string, unknown>)?.type === "text_delta"
    )
    .map((e) => ((e.delta as Record<string, unknown>).text as string) ?? "");
}

function createGeminiState(): Record<string, unknown> {
  return {
    _xmlInvokeBuffer: "",
    _markdownBuffer: "",
    _markdownCodeSpanRun: 0,
    _markdownFenceRun: 0,
  };
}

function geminiChunk(text: string, finish = false): Record<string, unknown> {
  return {
    responseId: "msg-eof-test",
    modelVersion: "gemini-2.5-flash",
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: finish ? "STOP" : undefined,
      },
    ],
  };
}

test("Gemini to Claude EOF: flushes held markdown buffer and closes block on null chunk", () => {
  const state = createGeminiState();
  // Chunk ending with trailing backtick in opener context -> held in buffer
  const chunk1 = geminiToClaudeResponse(geminiChunk("Run `code"), state);
  assert.equal(state._markdownBuffer, "`code");

  // Stream ends with EOF (null chunk) without finishReason
  const chunk2 = geminiToClaudeResponse(null, state);
  assert.ok(chunk2, "Expected non-null response for EOF flush of held buffer");

  const flushedEvents = chunk2 as Record<string, unknown>[];
  assert.equal(state._markdownBuffer, "");
  assert.equal(state.openTextBlockIdx, null);

  const flushedDeltas = getTextDeltas(flushedEvents);
  assert.deepEqual(flushedDeltas, ["`code"]);

  // Must emit content_block_stop
  const stopEvent = flushedEvents.find((e) => e.type === "content_block_stop");
  assert.ok(stopEvent, "Expected content_block_stop on EOF flush");
  assert.equal(typeof stopEvent.index, "number");

  // Full reconstructed text must match original input
  const allEvents = flatten([chunk1, chunk2]);
  const fullText = getTextDeltas(allEvents).join("");
  assert.equal(fullText, "Run `code");
});

test("Gemini to Claude EOF: repeated null chunk call is a no-op", () => {
  const state = createGeminiState();
  geminiToClaudeResponse(geminiChunk("Run `code"), state);

  // First flush emits held buffer and closes text block
  const chunkFlush1 = geminiToClaudeResponse(null, state);
  assert.ok(chunkFlush1);

  // Second flush must return null
  const chunkFlush2 = geminiToClaudeResponse(null, state);
  assert.equal(chunkFlush2, null);
});

test("Gemini to Claude EOF: uninitialized state returns null on null chunk", () => {
  const emptyState: Record<string, unknown> = {};
  const res1 = geminiToClaudeResponse(null, emptyState);
  assert.equal(res1, null);

  const stateWithoutMsgId: Record<string, unknown> = {
    openTextBlockIdx: 0,
  };
  const res2 = geminiToClaudeResponse(null, stateWithoutMsgId);
  assert.equal(res2, null);
});

test("Gemini to Claude EOF: state with upstreamError returns null on null chunk", () => {
  const state = createGeminiState();
  geminiToClaudeResponse(geminiChunk("Some text `"), state);
  state.upstreamError = { status: 500, message: "Gemini error" };

  const res = geminiToClaudeResponse(null, state);
  assert.equal(res, null);
});

test("Gemini to Claude EOF: already finished state returns null on null chunk", () => {
  const state = createGeminiState();
  // Normal finish with STOP
  const chunk1 = geminiToClaudeResponse(geminiChunk("Hello world", true), state);
  assert.ok(chunk1);
  assert.equal(state.openTextBlockIdx, null);
  assert.equal(state._markdownBuffer, "");

  // Null chunk after clean STOP
  const chunk2 = geminiToClaudeResponse(null, state);
  assert.equal(chunk2, null);
});

test("Gemini to Claude EOF: does not synthesize message_delta or message_stop on null chunk", () => {
  const state = createGeminiState();
  geminiToClaudeResponse(geminiChunk("Text `held"), state);

  const flushed = geminiToClaudeResponse(null, state) as Record<string, unknown>[];
  assert.ok(flushed);

  const messageDelta = flushed.find((e) => e.type === "message_delta");
  const messageStop = flushed.find((e) => e.type === "message_stop");
  assert.equal(messageDelta, undefined, "Must not synthesize message_delta on null chunk");
  assert.equal(messageStop, undefined, "Must not synthesize message_stop on null chunk");
});

test("Gemini to Claude EOF partition invariance: Korean markdown, backticks, and escape sequences", () => {
  const testCases = [
    "안녕하세요, `코드 블록` 테스트입니다. `미종료 백틱",
    "**한국어 굵은 글씨** 및 *기울임* 그리고 `인라인 코드`와 trailing *",
    "수식: \\(x + y = z\\) 그리고 \\[A = B\\] 및 $$E = mc^2$$ 그리고 $",
    "이스케이프 문자: \\`백틱\\` 및 \\*별표\\* 그리고 trailing \\",
    "코드 펜스:\n```typescript\nconst a = 1;\n```\n그리고 대기 ```py",
  ];

  for (const originalText of testCases) {
    // Partition text into 2 chunks at every possible boundary
    for (let splitIdx = 1; splitIdx < originalText.length; splitIdx++) {
      const part1 = originalText.slice(0, splitIdx);
      const part2 = originalText.slice(splitIdx);

      const state = createGeminiState();
      const chunk1 = geminiToClaudeResponse(geminiChunk(part1), state);
      const chunk2 = geminiToClaudeResponse(geminiChunk(part2), state);
      const chunkFlush = geminiToClaudeResponse(null, state);

      const allEvents = flatten([chunk1, chunk2, chunkFlush]);
      const reconstructed = getTextDeltas(allEvents).join("");
      assert.equal(
        reconstructed,
        originalText,
        `Reconstructed text mismatch for split at index ${splitIdx} on text: "${originalText}"`
      );
      assert.equal(state._markdownBuffer, "", "Buffer must be empty after flush");
      assert.equal(state.openTextBlockIdx, null, "Text block must be closed after flush");
    }
  }
});
