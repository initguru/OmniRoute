import assert from "node:assert/strict";
import test from "node:test";

import type { ZcodeClientLike } from "../../open-sse/executors/zcodeProtocol.ts";
import type { ZcodeClientFactoryOptions } from "../../open-sse/executors/zcode.ts";

type CaptchaResult = { verifyParam: string; region: string };
type CaptchaSolver = { solve: (options?: { timeoutMs?: number }) => Promise<CaptchaResult> };
type RequestCall = { method: string; params: unknown };
type RuntimeModel = {
  model?: { providerId?: string; modelId?: string };
  provider?: { providerId?: string; baseURL?: string; headers?: Record<string, string> };
};

const REQUEST_BODY = { messages: [{ role: "user", content: "Return a short status." }] };
const FIRST_VERIFY_PARAM = "f".repeat(256);
const REFRESH_VERIFY_PARAM = "r".repeat(256);

async function loadZcodeExecutor() {
  return import("../../open-sse/executors/zcode.ts");
}

function createClient(
  options: ZcodeClientFactoryOptions,
  behavior: { failFirstSend?: boolean },
  requests: RequestCall[],
): ZcodeClientLike {
  const sessionId = "captcha-test-session";
  let sendCalls = 0;
  return {
    start: async () => undefined,
    call: async (method, params = {}) => {
      if (method === "workspace/readState") return { modelCatalog: { providers: [] } };
      if (method === "session/create") {
        const response = await options.onRequest("session/requestRuntimePreferences", { sessionId }, "server-1");
        assert.deepEqual(response, { nativeSearchEnhancementsEnabled: false });
        return { session: { sessionId, status: "idle" } };
      }
      if (method === "session/updateRuntimeModelConfig") {
        requests.push({ method, params });
        return {
          appliedModelRuntimeRevision: (params as { runtimeModel?: { revision?: string } }).runtimeModel?.revision || "runtime-test",
          changed: true,
          runtimeApplied: true,
          sessionId,
        };
      }
      if (method === "session/subscribe") return { sessionId, eventSeq: 0, events: [] };
      if (method === "session/send") {
        const response = await options.onRequest("interaction/requestProviderRuntimeHeaders", {
          requestId: "request-test",
          sessionId,
          turnId: "turn-test",
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
          modelRef: { providerId: "builtin:zai-start-plan", modelId: "GLM-5.2" },
          providerId: "builtin:zai-start-plan",
          reason: "model-request",
        }, "server-2");
        requests.push({ method: "interaction/requestProviderRuntimeHeaders", params: response });
        assert.deepEqual(response, { headersApplied: true });
        sendCalls += 1;
        if (behavior.failFirstSend && sendCalls === 1) {
          throw {
            code: -32603,
            data: { code: 3007, message: "Captcha verify failed" },
            message: "request failed",
          };
        }
        queueMicrotask(() => options.onNotification?.("session/event", {
          sessionId,
          seq: 1,
          type: "turn.completed",
          payload: { response: "captcha-safe response", resultType: "success" },
        }));
        return { accepted: true, sessionId };
      }
      if (method === "session/close") return { closed: true };
      throw new Error(`unexpected ZCode method ${method}`);
    },
    close: async () => undefined,
  };
}

test("ZcodeExecutor applies solved captcha as runtime headers", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const requests: RequestCall[] = [];
  const solverCalls: Array<{ timeoutMs?: number }> = [];
  const captcha: CaptchaSolver = {
    solve: async (options) => {
      solverCalls.push(options ?? {});
      return { verifyParam: FIRST_VERIFY_PARAM, region: "sgp" };
    },
  };
  const executor = new ZcodeExecutor({
    captchaSolver: captcha,
    captchaTimeoutMs: 777,
    clientFactory: (options = { onRequest: async () => ({}) }) => createClient(options, {}, requests),
  });

  const result = await executor.execute({ model: "glm-5.2", body: REQUEST_BODY, stream: false, credentials: {} });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.deepEqual(solverCalls, [{ timeoutMs: 777 }]);
  const runtimeUpdate = requests.find(({ method }) => method === "session/updateRuntimeModelConfig");
  const provider = (runtimeUpdate?.params as { runtimeModel?: { provider?: { headers?: Record<string, string> } } })
    .runtimeModel?.provider;
  assert.equal((runtimeUpdate?.params as { runtimeModel?: RuntimeModel }).runtimeModel?.model?.providerId, "builtin:zai-start-plan");
  assert.equal((runtimeUpdate?.params as { runtimeModel?: RuntimeModel }).runtimeModel?.model?.modelId, "GLM-5.2");
  assert.equal((runtimeUpdate?.params as { runtimeModel?: RuntimeModel }).runtimeModel?.provider?.providerId, "builtin:zai-start-plan");
  assert.equal(provider?.baseURL, "https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  assert.equal(provider?.headers?.["x-aliyun-captcha-verify-param"], FIRST_VERIFY_PARAM);
  assert.equal(provider?.headers?.["x-aliyun-captcha-verify-region"], "sgp");
  assert.deepEqual(requests.find(({ method }) => method === "interaction/requestProviderRuntimeHeaders")?.params, {
    headersApplied: true,
  });
});

test("ZcodeExecutor obtains a fresh captcha and retries one 3007 verification failure", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const requests: RequestCall[] = [];
  const captchaResults: CaptchaResult[] = [
    { verifyParam: FIRST_VERIFY_PARAM, region: "sgp" },
    { verifyParam: REFRESH_VERIFY_PARAM, region: "sgp" },
  ];
  let solveCalls = 0;
  let clientsCreated = 0;
  const captcha: CaptchaSolver = { solve: async () => captchaResults[solveCalls++] as CaptchaResult };
  const executor = new ZcodeExecutor({
    captchaSolver: captcha,
    clientFactory: (options = { onRequest: async () => ({}) }) => {
      clientsCreated += 1;
      return createClient(options, { failFirstSend: clientsCreated === 1 }, requests);
    },
  });

  const result = await executor.execute({ model: "glm-5.2", body: REQUEST_BODY, stream: false, credentials: {} });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.equal(clientsCreated, 2);
  assert.equal(solveCalls, 2);
  const runtimeUpdates = requests.filter(({ method }) => method === "session/updateRuntimeModelConfig");
  assert.equal(runtimeUpdates.length, 4);
  const firstRuntimeModel = (runtimeUpdates[0]?.params as { runtimeModel?: RuntimeModel }).runtimeModel;
  const secondAttemptRuntimeModel = (runtimeUpdates[2]?.params as { runtimeModel?: RuntimeModel }).runtimeModel;
  assert.equal(firstRuntimeModel?.model?.providerId, "builtin:zai-start-plan");
  assert.equal(firstRuntimeModel?.model?.modelId, "GLM-5.2");
  assert.equal(firstRuntimeModel?.provider?.headers?.["x-aliyun-captcha-verify-param"], FIRST_VERIFY_PARAM);
  assert.equal(secondAttemptRuntimeModel?.model?.providerId, "builtin:zai-start-plan");
  assert.equal(secondAttemptRuntimeModel?.model?.modelId, "GLM-5.2");
  assert.equal(secondAttemptRuntimeModel?.provider?.headers?.["x-aliyun-captcha-verify-param"], REFRESH_VERIFY_PARAM);
});
