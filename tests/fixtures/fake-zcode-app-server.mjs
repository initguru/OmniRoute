let input = "";
let sessionId = "fake-zcode-session";
let pendingCreate;
let runtimeModel;
let subscribed = false;
let requestCounter = 0;
const outputQueue = [];
let outputBusy = false;
let nestedCaptchaFailure = false;
const unappliedRuntime = process.argv.includes("--unapplied-runtime");
const failureNotificationMode = process.argv.find((arg) => arg.startsWith("--failure-notifications="))?.split("=", 2)[1];
const defaultModel = process.argv.find((arg) => arg.startsWith("--default-model="))?.split("=", 2)[1] || "GLM-5.2";
let activeModel = defaultModel;

const modelCatalog = {
  available: [
    { ref: { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3-Flash" }, label: "GLM-5.3-Flash" },
    { ref: { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3" }, label: "GLM-5.3" },
  ],
  providers: [{
    providerId: "builtin:zai-start-plan",
    kind: "openai-compatible",
    source: "builtin",
    label: "Z.ai - Coding Plan",
    models: [
      { modelId: "GLM-5.3-Flash", label: "GLM-5.3-Flash" },
      { modelId: "GLM-5.3", label: "GLM-5.3" },
    ],
  }],
  revision: 0,
};

function send(message) {
  outputQueue.push(`${JSON.stringify(message)}\n`);
  flushOutput();
}

function flushOutput() {
  if (outputBusy || outputQueue.length === 0) return;
  outputBusy = true;
  const line = outputQueue.shift();
  const split = Math.max(1, Math.floor(line.length / 3));
  process.stdout.write(line.slice(0, split));
  setTimeout(() => {
    process.stdout.write(line.slice(split));
    outputBusy = false;
    flushOutput();
  }, 1);
}

function result(id, value) {
  send({ id, result: value });
}

function error(id, code, message) {
  send({ id, error: { code, message } });
}

function notification(method, params) {
  send({ method, params });
}

function serverRequest(method, params) {
  const id = `server-${++requestCounter}`;
  send({ id, method, params });
  return id;
}

function completionNotifications() {
  if (!subscribed) return;
  if (failureNotificationMode) {
    const failure = {
      code: -32603,
      data: { code: 3007, message: "Captcha verify failed" },
      message: "request failed",
    };
    if (failureNotificationMode === "state") {
      notification("state.updated", { sessionId, patch: { status: "failed", error: failure } });
    } else {
      notification("session/event", { sessionId, seq: 99, type: "turn.failed", payload: failure });
    }
    return;
  }
  notification("state.updated", {
    type: "state.updated",
    scope: "session",
    sessionId,
    revision: 1,
    patch: { status: "running" },
  });
  notification("session/event", {
    sessionId,
    seq: 1,
    type: "part.delta",
    payload: { messageId: "assistant-message", partId: "assistant-part", field: "text", delta: "fake zcode response" },
  });
  notification("session/event", {
    sessionId,
    seq: 2,
    type: "turn.completed",
    payload: { response: "fake zcode response", resultType: "success", tokenCount: 3, toolCallCount: 0, duration: 1 },
  });
  notification("state.updated", {
    type: "state.updated",
    scope: "session",
    sessionId,
    revision: 2,
    patch: {
      status: "completed",
      messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "fake zcode response" }] }],
    },
  });
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params = {} } = message;
  if (typeof method !== "string") return;
  const args = params && typeof params === "object" ? params : {};
  switch (method) {
    case "workspace/readState":
      result(id, {
        modelCatalog,
        settings: { model: { available: modelCatalog.available } },
        workspace: args.workspace,
      });
      return;
    case "session/create": {
      const requestedModel = args.model;
      const requestedModelId = requestedModel && typeof requestedModel === "object" ? requestedModel.modelId : undefined;
      if (typeof requestedModelId === "string") activeModel = requestedModelId;
      sessionId = "fake-zcode-session";
      pendingCreate = id;
      const preferenceRequestId = serverRequest("session/requestRuntimePreferences", { sessionId });
      pendingCreate = { id, preferenceRequestId };
      return;
    }
    case "session/subscribe":
      subscribed = args.deliveryKind === "desktop-continuous";
      result(id, { sessionId, eventSeq: 0, events: [] });
      return;
    case "session/updateRuntimeModelConfig":
      runtimeModel = args.runtimeModel;
      const runtimeModelMatchesActive = runtimeModel?.model?.modelId === activeModel;
      result(id, {
        appliedModelRuntimeRevision: unappliedRuntime
          ? "model-runtime:unapplied"
          : runtimeModel?.revision || "runtime-revision",
        changed: !unappliedRuntime && runtimeModelMatchesActive,
        runtimeApplied: !unappliedRuntime && runtimeModelMatchesActive,
        sessionId,
      });
      return;
    case "session/send":
      if (typeof args.content !== "string") {
        error(id, -32602, "content must be a string");
        return;
      }
      if (args.content === "trigger nested captcha failure" && !nestedCaptchaFailure) {
        nestedCaptchaFailure = true;
        send({
          id,
          error: {
            code: -32603,
            message: "request failed",
            data: { code: 3007, message: "Captcha verify failed" },
          },
        });
        return;
      }
      result(id, { accepted: true, sessionId });
      setTimeout(completionNotifications, 2);
      return;
    case "session/close":
      result(id, { closed: true });
      return;
    default:
      result(id, {});
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id && message.result && pendingCreate && message.id === pendingCreate.preferenceRequestId) {
      result(pendingCreate.id, { session: { sessionId, status: "idle" }, preferencesReceived: true });
      pendingCreate = undefined;
      continue;
    }
    handle(message);
  }
});

process.stdin.on("end", () => process.exit(0));
