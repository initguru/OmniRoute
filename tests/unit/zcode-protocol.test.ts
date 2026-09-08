import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ZcodeAppServerClient } from "../../open-sse/executors/zcodeProtocol.ts";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");

test("ZCode protocol uses NDJSON, answers server requests, and sends string session content", async () => {
  const requests: Array<{ id: string; method: string; params: unknown }> = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  let resolveNotifications!: () => void;
  const notificationsDone = new Promise<void>((resolve) => {
    resolveNotifications = resolve;
  });
  const client = new ZcodeAppServerClient({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    startupTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    onRequest: (method, params) => {
      requests.push({ id: "server-1", method, params });
      if (method === "session/requestRuntimePreferences") {
        return { nativeSearchEnhancementsEnabled: false };
      }
      return {};
    },
    onNotification: (method, params) => {
      notifications.push({ method, params });
      if (notifications.length >= 4) resolveNotifications();
    },
  });
  try {
    await client.start();
    const workspace = { workspacePath: "/workspace", workspaceKey: "/workspace" };
    const state = await client.call("workspace/readState", { workspace });
    assert.equal((state as { workspace: { workspacePath: string } }).workspace.workspacePath, "/workspace");

    const created = await client.call("session/create", {
      workspace,
      model: { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3-Flash" },
    });
    assert.equal((created as { preferencesReceived: boolean }).preferencesReceived, true);
    const sessionId = (created as { session: { sessionId: string } }).session.sessionId;

    await client.call("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
    const sent = await client.call("session/send", { sessionId, content: "Return a short status." });
    assert.deepEqual(sent, { accepted: true, sessionId });
    await notificationsDone;

    await assert.rejects(
      client.call("session/send", { sessionId, content: "trigger nested captcha failure" }),
      (error: unknown) => {
        const normalized = error as Error & { code?: unknown; data?: { code?: unknown }; providerCode?: unknown };
        assert.equal(normalized.code, -32603);
        assert.equal(normalized.data?.code, 3007);
        assert.equal(normalized.providerCode, 3007);
        return true;
      },
    );

    assert.deepEqual(requests, [{
      id: "server-1",
      method: "session/requestRuntimePreferences",
      params: { sessionId },
    }]);
    assert.equal(notifications.some(({ method }) => method === "state.updated"), true, JSON.stringify(notifications));
    assert.equal(notifications.some(({ method }) => method === "session/event"), true, JSON.stringify(notifications));
  } finally {
    await client.close();
  }
});
