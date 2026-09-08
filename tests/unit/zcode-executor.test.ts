import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ZcodeClientFactoryOptions } from "../../open-sse/executors/zcode.ts";
import type { ZcodeClientLike } from "../../open-sse/executors/zcodeProtocol.ts";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-zcode-"));
process.env.DATA_DIR = TEST_DATA_DIR;

test.after(() =>
  rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
);

async function loadZcodeExecutor() {
  return import("../../open-sse/executors/zcode.ts");
}

test("preserves oversized tool output from the most recent two turns", async () => {
  const { buildZcodePrompt } = await loadZcodeExecutor();
  const recentToolOutput = "recent-tool-output-" + "x".repeat(1_500);
  const prompt = buildZcodePrompt([
    { role: "user", content: "turn one" },
    { role: "tool", content: "old-tool-output" },
    { role: "user", content: "turn two" },
    { role: "tool", content: recentToolOutput },
    { role: "user", content: "turn three" },
  ]);

  assert.match(prompt, new RegExp(recentToolOutput));
  assert.doesNotMatch(prompt, /truncated \\d+ chars of previous tool output/);
});

test("truncates oversized tool output older than the most recent two turns", async () => {
  const { buildZcodePrompt } = await loadZcodeExecutor();
  const oldToolOutput = "old-tool-output-" + "x".repeat(1_500);
  const prompt = buildZcodePrompt([
    { role: "user", content: "turn one" },
    { role: "tool", content: oldToolOutput },
    { role: "user", content: "turn two" },
    { role: "assistant", content: "answer two" },
    { role: "user", content: "turn three" },
    { role: "assistant", content: "answer three" },
  ]);

  assert.match(prompt, /\.\.\. \[truncated 716 chars of previous tool output\] \.\.\./);
  assert.ok(!prompt.includes(oldToolOutput));
  assert.ok(prompt.includes(oldToolOutput.slice(0, 500)));
  assert.ok(prompt.includes(oldToolOutput.slice(-300)));
});

type CaptchaResult = { verifyParam: string; region: string };
type CaptchaSolver = { solve: (options?: { timeoutMs?: number }) => Promise<CaptchaResult> };
type FakeBehavior = { failFirstSend?: boolean; onClose?: () => void | Promise<void> };
type RuntimeUpdate = { method: string; params: unknown };
type FakeClientOptions = ZcodeClientFactoryOptions & { failureNotifications?: string };
type RuntimeModel = {
  model?: { providerId?: string; modelId?: string };
  provider?: { providerId?: string; baseURL?: string; headers?: Record<string, string> };
};

function createFakeClient(
  options: FakeClientOptions,
  behavior: FakeBehavior,
  updates: RuntimeUpdate[]
): ZcodeClientLike {
  const sessionId = "captcha-session";
  let sendCalls = 0;
  const notify = options.onNotification;
  const failureNotifications = new Set(options.failureNotifications?.split(",") ?? []);
  return {
    start: async () => undefined,
    call: async (method, params = {}) => {
      if (method === "workspace/readState") return { modelCatalog: { providers: [] } };
      if (method === "session/create") {
        const preferenceResult = await options.onRequest(
          "session/requestRuntimePreferences",
          { sessionId },
          "server-1"
        );
        assert.deepEqual(preferenceResult, { nativeSearchEnhancementsEnabled: false });
        return { session: { sessionId, status: "idle" } };
      }
      if (method === "session/updateRuntimeModelConfig") {
        updates.push({ method, params });
        return {
          appliedModelRuntimeRevision:
            (params as { runtimeModel?: { revision?: string } }).runtimeModel?.revision ||
            "runtime-test",
          changed: true,
          runtimeApplied: true,
          sessionId,
        };
      }
      if (method === "session/subscribe") return { sessionId, eventSeq: 0, events: [] };
      if (method === "session/send") {
        const headerResult = await options.onRequest(
          "interaction/requestProviderRuntimeHeaders",
          {
            requestId: "request-test",
            sessionId,
            turnId: "turn-test",
            workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
            modelRef: { providerId: "builtin:zai-start-plan", modelId: "GLM-5.2" },
            providerId: "builtin:zai-start-plan",
            reason: "model-request",
          },
          "server-2"
        );
        assert.deepEqual(headerResult, { headersApplied: true });
        sendCalls += 1;
        if (behavior.failFirstSend && sendCalls === 1) {
          throw {
            code: -32603,
            data: { code: 3007, message: "Captcha verify failed" },
            message: "request failed",
          };
        }
        queueMicrotask(() => {
          if (failureNotifications.has("event")) {
            notify?.("session/event", {
              sessionId,
              seq: 99,
              type: "turn.failed",
              payload: {
                code: -32603,
                data: { code: 3007, message: "Captcha verify failed" },
                message: "request failed",
              },
            });
            return;
          }
          if (failureNotifications.has("state")) {
            notify?.("state.updated", {
              sessionId,
              patch: {
                status: "failed",
                error: {
                  code: -32603,
                  data: { code: 3007, message: "Captcha verify failed" },
                  message: "request failed",
                },
              },
            });
            return;
          }
          notify?.("session/event", {
            sessionId,
            seq: 1,
            type: "turn.completed",
            payload: { response: "captcha response", resultType: "success" },
          });
        });
        return { accepted: true, sessionId };
      }
      if (method === "session/close") return { closed: true };
      throw new Error(`unexpected ZCode method ${method}`);
    },
    close: async () => {
      await behavior.onClose?.();
    },
  };
}

const defaultCaptchaSolver: CaptchaSolver = {
  solve: async () => ({ verifyParam: "x".repeat(256), region: "sgp" }),
};

function requestBody() {
  return {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Reply with a short status." },
    ],
  };
}

test("ZCode accepts Coding Plan models and rejects unsafe or unknown ids", async () => {
  const { resolveZcodeModel } = await loadZcodeExecutor();
  assert.deepEqual(resolveZcodeModel("glm-5.2"), { ok: true, model: "glm-5.2" });
  assert.deepEqual(resolveZcodeModel("glm-5.3"), { ok: true, model: "glm-5.3" });
  assert.equal(resolveZcodeModel("glm-5.2-high").ok, false);
  assert.equal(resolveZcodeModel("glm-5.3-low").ok, false);
  assert.equal(resolveZcodeModel("-unexpected").ok, false);
  assert.equal(resolveZcodeModel("unknown-model").ok, false);
});

for (const [model, officialId] of [
  ["glm-5.3-flash", "GLM-5.3-Flash"],
  ["glm-5.3", "GLM-5.3"],
] as const) {
  test(`ZCode maps ${model} to the official app-server model id`, async () => {
    const { ZcodeExecutor } = await loadZcodeExecutor();
    const updates: RuntimeUpdate[] = [];
    const executor = new ZcodeExecutor({
      captchaSolver: defaultCaptchaSolver,
      clientFactory: (options = { onRequest: async () => ({}) }) =>
        createFakeClient(options, {}, updates),
    });
    const result = await executor.execute({
      model,
      body: requestBody(),
      stream: false,
      credentials: {},
    });
    const response = "response" in result ? result.response : result;
    assert.equal(response.status, 200);
    const runtimeModel = (
      updates.find(({ method }) => method === "session/updateRuntimeModelConfig")?.params as {
        runtimeModel?: RuntimeModel;
      }
    ).runtimeModel;
    assert.equal(runtimeModel?.model?.providerId, "builtin:zai-start-plan");
    assert.equal(runtimeModel?.model?.modelId, officialId);
    assert.equal(runtimeModel?.provider?.providerId, "builtin:zai-start-plan");
  });
}

test("ZCode normalizes state.updated patch errors with the direct session event contract", async () => {
  const { notificationError } = await loadZcodeExecutor();
  const nestedData = { code: 3007, message: "Captcha verify failed", requestId: "state-update" };
  const direct = notificationError({ code: -32603, data: nestedData, message: "request failed" });
  const stateUpdated = notificationError({
    status: "failed",
    error: { code: -32603, data: nestedData, message: "request failed" },
  });

  for (const error of [direct, stateUpdated]) {
    const normalized = error as Error & { code?: unknown; providerCode?: unknown; data?: unknown };
    assert.equal(normalized.code, -32603);
    assert.equal(normalized.providerCode, 3007);
    assert.deepEqual(normalized.data, nestedData);
  }
});

test("ZCode selects the requested model during session creation when the default differs", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  for (const [model, defaultModel] of [
    ["glm-5.3-flash", "GLM-5.3"],
    ["glm-5.3", "GLM-5.3-Flash"],
  ] as const) {
    const executor = new ZcodeExecutor({
      command: process.execPath,
      args: [fixture, `--default-model=${defaultModel}`],
      cwd: process.cwd(),
      requestTimeoutMs: 3000,
      turnTimeoutMs: 3000,
      captchaSolver: defaultCaptchaSolver,
    });
    const result = await executor.execute({
      model,
      body: requestBody(),
      stream: false,
      credentials: {},
    });
    const response = "response" in result ? result.response : result;
    assert.equal(response.status, 200, `${model} should override the configured default model`);
  }
});

test("ZCode runs the official app-server lifecycle and returns assistant text", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
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
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "glm-5.2");
  assert.equal(body.choices?.[0]?.message?.role, "assistant");
  assert.equal(body.choices?.[0]?.message?.content, "fake zcode response");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
});

test("ZCode applies captcha headers through runtime model configuration", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const updates: RuntimeUpdate[] = [];
  const executor = new ZcodeExecutor({
    captchaSolver: defaultCaptchaSolver,
    captchaTimeoutMs: 777,
    clientFactory: (options = { onRequest: async () => ({}) }) =>
      createFakeClient(options, {}, updates),
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.ok(updates.length >= 2);
  const runtimeModel = updates.at(-1)?.params as { runtimeModel?: RuntimeModel };
  assert.equal(runtimeModel.runtimeModel?.model?.providerId, "builtin:zai-start-plan");
  assert.equal(runtimeModel.runtimeModel?.model?.modelId, "GLM-5.2");
  assert.equal(runtimeModel.runtimeModel?.provider?.providerId, "builtin:zai-start-plan");
  assert.equal(
    runtimeModel.runtimeModel?.provider?.baseURL,
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
  );
  assert.equal(
    runtimeModel.runtimeModel?.provider?.headers?.["x-aliyun-captcha-verify-region"],
    "sgp"
  );
  assert.equal(
    runtimeModel.runtimeModel?.provider?.headers?.["x-aliyun-captcha-verify-param"]?.length,
    256
  );
});

test("ZCode refreshes captcha once after a 3007 verification failure", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const captchaResults = [
    { verifyParam: "a".repeat(256), region: "sgp" },
    { verifyParam: "b".repeat(256), region: "sgp" },
  ];
  let solveCalls = 0;
  let clientsCreated = 0;
  const requests: RuntimeUpdate[] = [];
  const lifecycle: string[] = [];
  const executor = new ZcodeExecutor({
    captchaSolver: {
      solve: async () => {
        lifecycle.push("solve");
        return captchaResults[solveCalls++] as CaptchaResult;
      },
    },
    clientFactory: (options = { onRequest: async () => ({}) }) => {
      clientsCreated += 1;
      lifecycle.push(`client-${clientsCreated}`);
      return createFakeClient(
        options,
        {
          failFirstSend: clientsCreated === 1,
          onClose: async () => {
            lifecycle.push(`close-${clientsCreated}`);
          },
        },
        requests
      );
    },
  });

  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.equal(clientsCreated, 2);
  assert.equal(solveCalls, 2);
  assert.ok(lifecycle.indexOf("close-1") >= 0);
  assert.ok(lifecycle.indexOf("close-1") < lifecycle.lastIndexOf("client-2"));
  const runtimeUpdates = requests.filter(
    ({ method }) => method === "session/updateRuntimeModelConfig"
  );
  assert.equal(runtimeUpdates.length, 4);
  const firstRuntimeModel = (runtimeUpdates[0]?.params as { runtimeModel?: RuntimeModel })
    .runtimeModel;
  const secondAttemptRuntimeModel = (runtimeUpdates[2]?.params as { runtimeModel?: RuntimeModel })
    .runtimeModel;
  assert.equal(firstRuntimeModel?.model?.providerId, "builtin:zai-start-plan");
  assert.equal(firstRuntimeModel?.model?.modelId, "GLM-5.2");
  assert.equal(
    firstRuntimeModel?.provider?.headers?.["x-aliyun-captcha-verify-param"],
    "a".repeat(256)
  );
  assert.equal(secondAttemptRuntimeModel?.model?.providerId, "builtin:zai-start-plan");
  assert.equal(secondAttemptRuntimeModel?.model?.modelId, "GLM-5.2");
  assert.equal(
    secondAttemptRuntimeModel?.provider?.headers?.["x-aliyun-captcha-verify-param"],
    "b".repeat(256)
  );
});

test("ZCode rejects an unapplied runtime model before subscribing or sending", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const calls: string[] = [];
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture, "--unapplied-runtime"],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    captchaSolver: defaultCaptchaSolver,
  });
  const result = await executor.execute({
    model: "glm-5.2",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 502);
  assert.match(await response.text(), /runtime model/i);
  assert.deepEqual(calls, []);
});

for (const failureMode of ["event", "state"] as const) {
  test(`ZCode retries ${failureMode} notification failures with nested captcha metadata`, async () => {
    const { ZcodeExecutor } = await loadZcodeExecutor();
    const captchaResults = [
      { verifyParam: "n".repeat(256), region: "sgp" },
      { verifyParam: "m".repeat(256), region: "sgp" },
    ];
    const updates: RuntimeUpdate[] = [];
    let solveCalls = 0;
    let clientsCreated = 0;
    const lifecycle: string[] = [];
    const executor = new ZcodeExecutor({
      captchaSolver: {
        solve: async () => {
          lifecycle.push("solve");
          return captchaResults[solveCalls++] as CaptchaResult;
        },
      },
      clientFactory: (options: FakeClientOptions = { onRequest: async () => ({}) }) => {
        clientsCreated += 1;
        lifecycle.push(`client-${clientsCreated}`);
        return createFakeClient(
          { ...options, failureNotifications: clientsCreated === 1 ? failureMode : undefined },
          {
            onClose: async () => {
              lifecycle.push(`close-${clientsCreated}`);
            },
          },
          updates
        );
      },
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
    assert.equal(clientsCreated, 2);
    assert.ok(lifecycle.indexOf("close-1") >= 0);
    assert.ok(lifecycle.indexOf("close-1") < lifecycle.lastIndexOf("client-2"));
    assert.equal(
      (updates[2]?.params as { runtimeModel?: RuntimeModel }).runtimeModel?.provider?.headers?.[
        "x-aliyun-captcha-verify-param"
      ],
      "m".repeat(256)
    );
  });
}

test("ZCode buffers the completed turn into OpenAI SSE when stream=true", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const executor = new ZcodeExecutor({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    requestTimeoutMs: 3000,
    turnTimeoutMs: 3000,
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
  assert.match(text, /fake zcode response/);
  assert.match(text, /data: \[DONE\]/);
});

test("ZCode reuses a conversation session and sends only appended messages", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const calls: Array<{ method: string; params: unknown }> = [];
  const executor = new ZcodeExecutor({
    captchaSolver: defaultCaptchaSolver,
    clientFactory: (options = { onRequest: async () => ({}) }) => ({
      start: async () => undefined,
      call: async (method: string, params: unknown = {}) => {
        calls.push({ method, params });
        if (method === "workspace/readState") return { modelCatalog: { providers: [] } };
        if (method === "session/create") return { session: { sessionId: "keep-alive-session" } };
        if (method === "session/updateRuntimeModelConfig") {
          const revision = (params as { runtimeModel?: { revision?: string } }).runtimeModel
            ?.revision;
          return { appliedModelRuntimeRevision: revision, runtimeApplied: true };
        }
        if (method === "session/subscribe") return { sessionId: "keep-alive-session" };
        if (method === "session/send") {
          queueMicrotask(() =>
            options.onNotification?.("session/event", {
              type: "turn.completed",
              payload: { response: "kept alive" },
            })
          );
          return { accepted: true };
        }
        return {};
      },
      close: async () => undefined,
    }),
  });
  const firstMessages = requestBody().messages;
  const secondMessages = [
    ...firstMessages,
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Now continue." },
  ];

  const first = await executor.execute({
    model: "glm-5.2",
    body: { conversation_id: "conversation-keep-alive", messages: firstMessages },
    stream: false,
    credentials: {},
  });
  assert.equal(("response" in first ? first.response : first).status, 200);

  const second = await executor.execute({
    model: "glm-5.2",
    body: { conversation_id: "conversation-keep-alive", messages: secondMessages },
    stream: false,
    credentials: {},
  });
  assert.equal(("response" in second ? second.response : second).status, 200);

  assert.equal(calls.filter(({ method }) => method === "session/create").length, 1);
  const sends = calls.filter(({ method }) => method === "session/send");
  assert.equal(sends.length, 2);
  const firstContent = (sends[0]?.params as { content?: string }).content;
  const secondContent = (sends[1]?.params as { content?: string }).content;
  assert.match(firstContent || "", /Reply with a short status/);
  assert.match(secondContent || "", /Now continue/);
  assert.doesNotMatch(secondContent || "", /You are a coding assistant/);
  assert.match(secondContent || "", /Earlier answer/);
});

test("ZCode accurately extracts and reports usage from turn.completed in both non-stream and stream modes", async () => {
  const { ZcodeExecutor } = await loadZcodeExecutor();
  const fakeUsage = {
    source: "provider",
    inputTokens: 28867,
    outputTokens: 55,
    totalTokens: 28922,
    cacheReadTokens: 1024,
  };

  const clientFactory = (options: FakeClientOptions = { onRequest: async () => ({}) }) => {
    return {
      start: async () => undefined,
      call: async (method: string, params: unknown = {}) => {
        if (method === "workspace/readState") return { modelCatalog: { providers: [] } };
        if (method === "session/create")
          return { session: { sessionId: "usage-session", status: "idle" } };
        if (method === "session/updateRuntimeModelConfig") {
          const p = params as { runtimeModel?: { revision?: string } };
          return {
            appliedModelRuntimeRevision: p?.runtimeModel?.revision || "r1",
            runtimeApplied: true,
          };
        }
        if (method === "session/subscribe")
          return { sessionId: "usage-session", eventSeq: 0, events: [] };
        if (method === "session/send") {
          queueMicrotask(() => {
            options.onNotification?.("session/event", {
              sessionId: "usage-session",
              type: "turn.completed",
              payload: {
                response: "Hello from ZCode with precise usage!",
                usage: fakeUsage,
              },
            });
          });
          return { accepted: true };
        }
        if (method === "session/close") return { closed: true };
        return {};
      },
      close: async () => undefined,
    };
  };

  const executor = new ZcodeExecutor({
    captchaSolver: defaultCaptchaSolver,
    clientFactory,
  });

  // 1. Non-streaming execution test
  const nonStreamResult = await executor.execute({
    model: "glm-5.3-flash",
    body: requestBody(),
    stream: false,
    credentials: {},
  });
  const nonStreamRes = "response" in nonStreamResult ? nonStreamResult.response : nonStreamResult;
  assert.equal(nonStreamRes.status, 200);
  const json = (await nonStreamRes.json()) as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  assert.equal(json.usage?.prompt_tokens, 28867);
  assert.equal(json.usage?.completion_tokens, 55);
  assert.equal(json.usage?.total_tokens, 28922);
  assert.equal(json.usage?.prompt_tokens_details?.cached_tokens, 1024);

  // Check transformedBody preserves context
  assert.ok("transformedBody" in nonStreamResult);
  const tb = nonStreamResult.transformedBody as Record<string, unknown>;
  assert.equal(tb.model, "glm-5.3-flash");
  assert.ok(Array.isArray(tb.messages));

  // 2. Streaming execution test
  const streamResult = await executor.execute({
    model: "glm-5.3-flash",
    body: requestBody(),
    stream: true,
    credentials: {},
  });
  const streamRes = "response" in streamResult ? streamResult.response : streamResult;
  assert.equal(streamRes.status, 200);
  const streamText = await streamRes.text();
  assert.match(streamText, /"prompt_tokens":28867/);
  assert.match(streamText, /"completion_tokens":55/);
  assert.match(streamText, /"total_tokens":28922/);
  assert.match(streamText, /"cached_tokens":1024/);
  assert.match(streamText, /data: \[DONE\]/);
});
