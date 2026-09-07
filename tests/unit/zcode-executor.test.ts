import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zcode-"));
process.env.DATA_DIR = TEST_DATA_DIR;

test.after(() =>
  rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
);

async function loadZcodeExecutor() {
  return import("../../open-sse/executors/zcode.ts");
}

type CaptchaResult = { verifyParam: string; region: string };

type CaptchaSolver = { solve: (options?: { timeoutMs?: number }) => Promise<CaptchaResult> };

type FakeClient = {
  start: () => Promise<void>;
  call: (channel: string, method: string, args: unknown[]) => Promise<unknown>;
  close: () => Promise<void>;
};

function createFakeClient(options: {
  onCall?: (method: string, args: unknown[]) => unknown;
  onRequest?: (channel: string, method: string, args: unknown[]) => unknown;
} = {}): FakeClient {
  let sessionId = "captcha-session";
  return {
    start: async () => undefined,
    call: async (channel, method, args) => {
      const custom = options.onRequest?.(channel, method, args) ?? options.onCall?.(method, args);
      if (custom !== undefined) return custom;
      if (method === "initialize") return { available: true };
      if (method === "createSession") return { session: { sessionId, status: "idle" } };
      if (method === "setModel") return { ok: true };
      if (method === "sendPrompt") return { session: { sessionId, status: "running" } };
      if (method === "readSession") {
        return {
          session: { sessionId, status: "completed" },
          messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "captcha response" }] }],
        };
      }
      if (method === "closeSession") return { ok: true };
      throw new Error(`unexpected method ${method}`);
    },
    close: async () => undefined,
  };
}

const defaultCaptchaSolver: CaptchaSolver = {
  solve: async () => ({ verifyParam: "test-verify-param", region: "sgp" }),
};

function requestBody() {
  return {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Reply with a short status." },
    ],
  };
}

test("ZCode accepts GLM Coding Plan models and rejects unsafe/unknown ids", async () => {
  const { resolveZcodeModel } = await loadZcodeExecutor();
  assert.deepEqual(resolveZcodeModel("glm-5.2"), { ok: true, model: "glm-5.2" });
  assert.equal(resolveZcodeModel("glm-5.2-high").ok, false);
  assert.equal(resolveZcodeModel("glm-5.3-low").ok, false);
  assert.equal(resolveZcodeModel("-unexpected").ok, false);
  assert.equal(resolveZcodeModel("unknown-model").ok, false);
});

test("ZCode runs a local app-server turn and returns an OpenAI chat completion", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    pollIntervalMs: 1,
    captchaSolver: defaultCaptchaSolver,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "glm-5.2");
  assert.equal(body.choices?.[0]?.message?.role, "assistant");
  assert.equal(body.choices?.[0]?.message?.content, "fake zcode response");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
});

test("ZCode acquires captcha headers through the provider runtime callback", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const captcha: CaptchaSolver = {
    solve: async () => ({ verifyParam: "verify-param-1", region: "sgp" }),
  };
  const executor = new ZcodeExecutor({
    clientFactory: ({ onRequest } = {}) => createFakeClient({
      onRequest: (channel, method, args) => {
        calls.push({ method: `${channel}/${method}`, args });
        if (channel === "interaction" && method === "requestProviderRuntimeHeaders") {
          return onRequest?.(channel, method, args) ?? { headersApplied: true, runtimeHeaders: {} };
        }
        if (method === "initialize") {
          const response = onRequest?.("interaction", "requestProviderRuntimeHeaders", [args]);
          calls.push({ method: "interaction/requestProviderRuntimeHeaders", args: [response] });
          return { available: true };
        }
        if (method === "createSession") return { session: { sessionId: "captcha-session", status: "idle" } };
        if (method === "setModel") return { ok: true };
        if (method === "sendPrompt") return { session: { sessionId: "captcha-session", status: "running" } };
        if (method === "readSession") return {
          session: { sessionId: "captcha-session", status: "completed" },
          messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "captcha response" }] }],
        };
        if (method === "closeSession") return { ok: true };
        return onRequest?.(channel, method, args);
      },
    }),
    captchaSolver: captcha,
    pollIntervalMs: 0,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = ("response" in result ? result.response : result);
  assert.equal(response.status, 200);
  assert.equal(calls.some(({ method }) => method === "interaction/requestProviderRuntimeHeaders"), true);
  const headerCall = calls.find(({ method }) => method === "interaction/requestProviderRuntimeHeaders");
  assert.deepEqual(headerCall?.args[0], {
    headersApplied: true,
    runtimeHeaders: {
      "x-aliyun-captcha-verify-param": "verify-param-1",
      "x-aliyun-captcha-verify-region": "sgp",
    },
  });
});

test("ZCode refreshes captcha and retries one failed 3007 turn", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const captchaResults = [
    { verifyParam: "verify-param-1", region: "sgp" },
    { verifyParam: "verify-param-2", region: "sgp" },
  ];
  let solveCalls = 0;
  let sendPromptCalls = 0;
  const captcha: CaptchaSolver = { solve: async () => captchaResults[solveCalls++] };
  const executor = new ZcodeExecutor({
    clientFactory: () => createFakeClient({
      onCall: (method) => {
        if (method === "sendPrompt" && sendPromptCalls++ === 0) {
          return { session: { sessionId: "captcha-session", status: "error" }, error: { code: 3007, message: "captcha verify failed" } };
        }
        return undefined;
      },
    }),
    captchaSolver: captcha,
    pollIntervalMs: 0,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.equal(solveCalls, 2);
  assert.equal(sendPromptCalls, 2);
});

test("ZCode buffers the completed turn into OpenAI SSE when stream=true", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    pollIntervalMs: 1,
    captchaSolver: defaultCaptchaSolver,
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: true,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(text, /fake zcode response/);
  assert.match(text, /data: \[DONE\]/);
});
