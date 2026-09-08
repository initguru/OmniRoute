import assert from "node:assert/strict";
import test from "node:test";

import type { ZcodeClientLike } from "../../open-sse/executors/zcodeProtocol.ts";
import type { ZcodeClientFactoryOptions } from "../../open-sse/executors/zcode.ts";

type CaptchaResult = { verifyParam: string; region: string };
type CaptchaSolver = {
  solve: (options?: { timeoutMs?: number }) => Promise<CaptchaResult>;
};
type RuntimeHeaders = {
  headersApplied?: boolean;
  runtimeHeaders?: Record<string, string>;
};
type RequestCall = {
  channel: string;
  method: string;
  response: RuntimeHeaders;
};

const REQUEST_BODY = {
  messages: [{ role: "user", content: "Return a short status." }],
};

async function loadZcodeExecutor() {
  return import("../../open-sse/executors/zcode.ts");
}

function createClient(
  options: ZcodeClientFactoryOptions,
  behavior: { sendPrompt: () => unknown },
  requests: RequestCall[]
): ZcodeClientLike {
  const sessionId = "captcha-test-session";
  return {
    start: async () => undefined,
    call: async (channel, method, args) => {
      if (channel === "interaction" && method === "requestProviderRuntimeHeaders") {
        const response = options.onRequest(channel, method, args) as RuntimeHeaders;
        requests.push({ channel, method, response });
        return response;
      }
      if (method === "initialize") {
        const response = options.onRequest("interaction", "requestProviderRuntimeHeaders", [args]) as RuntimeHeaders;
        requests.push({
          channel: "interaction",
          method: "requestProviderRuntimeHeaders",
          response,
        });
        return { available: true };
      }
      if (method === "createSession") return { session: { sessionId, status: "idle" } };
      if (method === "setModel") return { ok: true };
      if (method === "sendPrompt") return behavior.sendPrompt();
      if (method === "readSession") {
        return {
          session: { sessionId, status: "completed" },
          messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "captcha-safe response" }] }],
        };
      }
      if (method === "closeSession") return { ok: true };
      throw new Error(`unexpected ZCode method ${method}`);
    },
    close: async () => undefined,
  };
}

test("ZcodeExecutor passes the solved captcha as provider runtime headers", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const requests: RequestCall[] = [];
  const solverCalls: Array<{ timeoutMs?: number }> = [];
  const captcha: CaptchaSolver = {
    solve: async (options) => {
      solverCalls.push(options ?? {});
      return { verifyParam: "verify-param-header", region: "sgp" };
    },
  };
  const executor = new ZcodeExecutor({
    captchaSolver: captcha,
    captchaTimeoutMs: 777,
    pollIntervalMs: 0,
    clientFactory: (options = { onRequest: () => ({}) }) =>
      createClient(options, {
        sendPrompt: () => ({ session: { sessionId: "captcha-test-session", status: "running" } }),
      }, requests),
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: REQUEST_BODY,
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;

  assert.equal(response.status, 200);
  assert.deepEqual(solverCalls, [{ timeoutMs: 777 }]);
  assert.deepEqual(requests, [{
    channel: "interaction",
    method: "requestProviderRuntimeHeaders",
    response: {
      headersApplied: true,
      runtimeHeaders: {
        "x-aliyun-captcha-verify-param": "verify-param-header",
        "x-aliyun-captcha-verify-region": "sgp",
      },
    },
  }]);
});

test("ZcodeExecutor obtains a fresh captcha and retries one 3007 verification failure", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const requests: RequestCall[] = [];
  const captchaResults: CaptchaResult[] = [
    { verifyParam: "verify-param-first", region: "sgp" },
    { verifyParam: "verify-param-refresh", region: "sgp" },
  ];
  let solveCalls = 0;
  let sendPromptCalls = 0;
  let clientsCreated = 0;
  const captcha: CaptchaSolver = {
    solve: async () => captchaResults[solveCalls++] as CaptchaResult,
  };
  const executor = new ZcodeExecutor({
    captchaSolver: captcha,
    pollIntervalMs: 0,
    clientFactory: (options = { onRequest: () => ({}) }) => {
      clientsCreated += 1;
      return createClient(options, {
        sendPrompt: () => {
          sendPromptCalls += 1;
          if (sendPromptCalls === 1) {
            return {
              session: { sessionId: "captcha-test-session", status: "error" },
              error: { code: 3007, message: "Captcha verify failed" },
            };
          }
          return { session: { sessionId: "captcha-test-session", status: "running" } };
        },
      }, requests);
    },
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: REQUEST_BODY,
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;

  assert.equal(response.status, 200);
  assert.equal(clientsCreated, 2);
  assert.equal(solveCalls, 2);
  assert.equal(sendPromptCalls, 2);
  assert.deepEqual(requests.map((request) => request.response.runtimeHeaders?.["x-aliyun-captcha-verify-param"]), [
    "verify-param-first",
    "verify-param-refresh",
  ]);
});
