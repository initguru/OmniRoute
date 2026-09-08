import assert from "node:assert/strict";
import test from "node:test";

import {
  ZcodeDirectExecutor,
  type ZcodeCaptchaSolver,
} from "../../open-sse/executors/zcodeDirect.ts";

const inputBase = {
  model: "glm-5.2",
  body: {
    messages: [{ role: "user", content: "Say hello" }],
    temperature: 0.2,
  },
  credentials: {},
  signal: undefined,
  log: undefined,
};

function solverHarness(tokens = ["captcha-one", "captcha-two"]) {
  let solveCalls = 0;
  let invalidateCalls = 0;
  const solver: ZcodeCaptchaSolver = {
    solve: async () => ({ verifyParam: tokens[solveCalls++] ?? tokens.at(-1)!, region: "sgp" }),
    invalidate: () => {
      invalidateCalls += 1;
    },
  };
  return {
    solver,
    get solveCalls() {
      return solveCalls;
    },
    get invalidateCalls() {
      return invalidateCalls;
    },
  };
}

function fetchResponse(body: unknown, status = 200, contentType = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

test("ZCode direct executor returns a non-streaming completion and sends direct protocol auth", async () => {
  const harness = solverHarness();
  let request: { url: string; init: RequestInit } | undefined;
  const executor = new ZcodeDirectExecutor({
    authOptions: { apiKey: "direct-key", baseURL: "https://direct.example.test/api/v1/zcode-plan" },
    captchaSolver: harness.solver,
    fetcher: async (url, init) => {
      request = { url: String(url), init };
      return fetchResponse({
        id: "chatcmpl-direct",
        object: "chat.completion",
        model: "glm-5.2",
        choices: [
          { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    },
  });

  const result = await executor.execute({ ...inputBase, stream: false });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "chatcmpl-direct",
    object: "chat.completion",
    model: "glm-5.2",
    choices: [
      { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  });
  assert.equal(request?.url, "https://direct.example.test/api/v1/zcode-plan/chat/completions");
  assert.equal(
    (request?.init.headers as Record<string, string>).authorization,
    "Bearer direct-key"
  );
  assert.equal(
    (request?.init.headers as Record<string, string>)["x-aliyun-captcha-verify-param"],
    "captcha-one"
  );
  assert.equal(JSON.parse(String(request?.init.body)).model, "glm-5.2");
  assert.equal(harness.solveCalls, 1);
});

test("ZCode direct executor emits standard SSE and preserves upstream token usage", async () => {
  const harness = solverHarness();
  const sse =
    [
      {
        id: "direct-stream",
        object: "chat.completion.chunk",
        model: "glm-5.2",
        choices: [{ index: 0, delta: { role: "assistant", content: "hel" }, finish_reason: null }],
      },
      {
        id: "direct-stream",
        object: "chat.completion.chunk",
        model: "glm-5.2",
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
      },
      {
        id: "direct-stream",
        object: "chat.completion.chunk",
        model: "glm-5.2",
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  const executor = new ZcodeDirectExecutor({
    authOptions: { apiKey: "direct-key" },
    captchaSolver: harness.solver,
    fetcher: async () => fetchResponse(sse, 200, "text/event-stream"),
  });

  const result = await executor.execute({ ...inputBase, stream: true });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"content":"hel"/);
  assert.match(text, /"content":"lo"/);
  assert.match(text, /"prompt_tokens":20/);
  assert.match(text, /"completion_tokens":2/);
  assert.doesNotMatch(text, /28867/);
  assert.match(text, /data: \[DONE\]/);
});

test("ZCode direct executor sanitizes upstream streaming error messages", async () => {
  const harness = solverHarness();
  const unsafeMessage =
    "upstream failed /Users/operator/.zcode/config.json\n    at /Users/operator/project/client.ts:42";
  const sse = `data: ${JSON.stringify({ error: { message: unsafeMessage } })}\n\n`;
  const executor = new ZcodeDirectExecutor({
    authOptions: { apiKey: "direct-key" },
    captchaSolver: harness.solver,
    fetcher: async () => fetchResponse(sse, 200, "text/event-stream"),
  });

  const result = await executor.execute({ ...inputBase, stream: true });
  const response = "response" in result ? result.response : result;
  const text = await response.text();
  assert.match(text, /upstream failed/);
  assert.doesNotMatch(text, /\/Users\/operator\/\.zcode\/config\.json/);
  assert.doesNotMatch(text, /at \/Users/);
});

test("ZCode direct executor cancels an aborted stream without hanging", async () => {
  const harness = solverHarness();
  const controller = new AbortController();
  let cancelCalls = 0;
  const upstreamBody = new ReadableStream<Uint8Array>({
    cancel() {
      cancelCalls += 1;
    },
  });
  const executor = new ZcodeDirectExecutor({
    authOptions: { apiKey: "direct-key" },
    captchaSolver: harness.solver,
    fetcher: async () =>
      new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });

  const result = await executor.execute({ ...inputBase, stream: true, signal: controller.signal });
  const response = "response" in result ? result.response : result;
  const reader = response.body?.getReader();
  assert.ok(reader);
  const pendingRead = reader.read();
  controller.abort(new Error("client disconnected"));
  const readResult = await Promise.race([
    pendingRead,
    new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
      setTimeout(() => reject(new Error("stream hung")), 250)
    ),
  ]);
  assert.ok(readResult.done || readResult.value !== undefined);
  await reader.cancel();
  assert.equal(cancelCalls, 1);
});

test("ZCode direct executor invalidates captcha and retries exactly once on code 3007", async () => {
  const harness = solverHarness(["expired-captcha", "fresh-captcha"]);
  let calls = 0;
  const headers: string[] = [];
  const executor = new ZcodeDirectExecutor({
    authOptions: { apiKey: "direct-key" },
    captchaSolver: harness.solver,
    fetcher: async (_url, init) => {
      calls += 1;
      headers.push((init?.headers as Record<string, string>)["x-aliyun-captcha-verify-param"]);
      if (calls === 1) return fetchResponse({ code: 3007, message: "captcha expired" }, 400);
      return fetchResponse({
        id: "chatcmpl-retry",
        object: "chat.completion",
        model: "glm-5.2",
        choices: [
          { index: 0, message: { role: "assistant", content: "retried" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
    },
  });

  const result = await executor.execute({ ...inputBase, stream: false });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "retried");
  assert.equal(calls, 2);
  assert.equal(harness.solveCalls, 2);
  assert.equal(harness.invalidateCalls, 1);
  assert.deepEqual(headers, ["expired-captcha", "fresh-captcha"]);
});

test("ZCode direct executor returns sanitized errors when auth is unavailable", async () => {
  const executor = new ZcodeDirectExecutor({
    authOptions: {},
    captchaSolver: solverHarness().solver,
    fetcher: async () => {
      throw new Error("must not fetch");
    },
  });

  const result = await executor.execute({ ...inputBase, stream: false });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.type, "authentication_error");
  assert.doesNotMatch(body.error.message, /must not fetch|at /);
});

test("ZCode direct executor immediately returns 499 on pre-aborted request without solving captcha", async () => {
  let solverCalled = false;
  const controller = new AbortController();
  controller.abort();
  const executor = new ZcodeDirectExecutor({
    authOptions: { apiKey: "direct-key" },
    captchaSolver: {
      solve: async () => {
        solverCalled = true;
        return { verifyParam: "v".repeat(256), region: "sgp" };
      },
      invalidate: () => undefined,
    },
  });

  const result = await executor.execute({ ...inputBase, signal: controller.signal });
  assert.equal(solverCalled, false);
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 499);
});
