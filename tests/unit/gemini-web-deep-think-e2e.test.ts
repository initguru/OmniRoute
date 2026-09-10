import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DB and DATA_DIR before transitive imports
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gweb-deep-think-e2e-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "gweb-deep-think-e2e-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const messagesRoute = await import("../../src/app/api/v1/messages/route.ts");
const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");

test("End-to-End: POST /v1/messages with gweb/gemini-deep-think emits early Anthropic keepalive pings during slow thinking", async (t) => {
  await core.ensureDbInitialized();

  await providersDb.createProviderConnection({
    provider: "gemini-web",
    authType: "cookie",
    name: "gweb-deep-think-e2e-connection",
    apiKey: "__Secure-1PSID=test-sid-e2e; __Secure-1PSIDTS=test-ts-e2e",
    isActive: true,
    testStatus: "active",
  });

  const originalExecute = GeminiWebExecutor.prototype.execute;

  t.after(async () => {
    GeminiWebExecutor.prototype.execute = originalExecute;
    // Allow any pending background logging / metrics promises to flush before tearing down DB
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise((resolve) => setImmediate(resolve));
    try {
      flushProxyLogsSync();
    } catch {
      // Ignore if already flushed or not initialized
    }
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  let executorInvoked = false;
  let executorInputModel: string | undefined;

  // Mock executor that delays for 5 seconds before yielding completion
  GeminiWebExecutor.prototype.execute = async function (input) {
    executorInvoked = true;
    executorInputModel = input.model;

    // Simulate 5-second deep thinking phase
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        // Delta with answer
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock-deep-think-e2e",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "gemini-deep-think",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "The verified answer is 42." },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          )
        );
        // Delta with stop
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock-deep-think-e2e",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "gemini-deep-think",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            })}\n\n`
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      response: new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: "https://gemini.google.com",
      headers: {},
      transformedBody: input.body,
    };
  };

  const request = new Request("http://localhost:20128/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: "gweb/gemini-deep-think",
      stream: true,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "Solve this complex reasoning riddle.",
        },
      ],
    }),
  });

  const startTime = Date.now();
  const response = await messagesRoute.POST(request);
  const routeCommitElapsed = Date.now() - startTime;

  // 1. Route returns 200 text/event-stream promptly within ~2 seconds (well before 5-second executor finish)
  assert.equal(response.status, 200, "Response status must be 200");
  assert.match(
    response.headers.get("content-type") || "",
    /text\/event-stream/,
    "Response must have text/event-stream content type"
  );
  assert.ok(
    routeCommitElapsed < 3500,
    `Route must return 200 text/event-stream within ~2 seconds (took ${routeCommitElapsed}ms)`
  );
  assert.ok(
    routeCommitElapsed >= 1800,
    `Route must wait for threshold before committing early keepalive (took ${routeCommitElapsed}ms)`
  );

  // Read the stream chunks and track elapsed arrival times
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullBody = "";
  const chunks: Array<{ elapsedMs: number; text: string }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const text = decoder.decode(value, { stream: true });
      chunks.push({ elapsedMs: Date.now() - startTime, text });
      fullBody += text;
    }
  }

  assert.equal(executorInvoked, true, "Mock executor must have been invoked");
  assert.equal(
    executorInputModel,
    "gemini-deep-think",
    "Bare model passed to executor must be gemini-deep-think"
  );

  // 2. Emits event: ping\ndata: {"type":"ping"}\n\n keepalive frames during slow thinking phase
  const pingChunk = chunks.find((c) => c.text.includes("event: ping"));
  assert.ok(pingChunk, "Stream must emit Anthropic event: ping keepalive frame");
  assert.match(
    pingChunk.text,
    /event: ping\ndata: \{"type":"ping"\}/,
    "Ping frame must match Anthropic ping format"
  );
  assert.ok(
    pingChunk.elapsedMs < 4500,
    `Anthropic ping frame must be received during the thinking phase before executor finishes (arrived at ${pingChunk.elapsedMs}ms)`
  );

  // 3. Ping frame is emitted before first content delta
  const pingIndex = fullBody.indexOf("event: ping");
  const contentIndex = fullBody.indexOf("The verified answer is 42.");
  assert.ok(pingIndex !== -1, "event: ping frame must exist in full body");
  assert.ok(contentIndex !== -1, "Answer content text must exist in full body");
  assert.ok(pingIndex < contentIndex, "Ping frame must appear before content delta in the stream");

  // 4. Resolves with single assistant text block once executor finishes
  const contentChunk = chunks.find((c) => c.text.includes("The verified answer is 42."));
  assert.ok(contentChunk, "Must receive chunk with answer content");
  assert.ok(
    contentChunk.elapsedMs >= 4800,
    `Content chunk must arrive after 5s executor finishes (arrived at ${contentChunk.elapsedMs}ms)`
  );

  assert.match(fullBody, /event: message_start/);
  assert.match(fullBody, /event: content_block_start/);
  assert.match(fullBody, /event: content_block_delta/);
  assert.match(fullBody, /event: content_block_stop/);
  assert.match(fullBody, /event: message_stop/);

  // Exactly one content block started and stopped
  const blockStarts = (fullBody.match(/event: content_block_start/g) || []).length;
  const blockStops = (fullBody.match(/event: content_block_stop/g) || []).length;
  assert.equal(blockStarts, 1, "Must have exactly 1 content_block_start");
  assert.equal(blockStops, 1, "Must have exactly 1 content_block_stop");

  // 5. Does not leak reasoning tokens or intermediate status text
  assert.ok(
    !fullBody.includes("reasoning_content"),
    "Must not leak reasoning_content in client wire format"
  );
  assert.ok(
    !fullBody.includes("thinking_delta"),
    "Must not leak thinking_delta in client wire format"
  );
  assert.ok(!fullBody.includes("thought"), "Must not leak internal thoughts in client wire format");
});
