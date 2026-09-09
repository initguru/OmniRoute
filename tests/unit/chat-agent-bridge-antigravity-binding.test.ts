import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agent-bridge-binding-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const agentBridgeState = await import("../../src/lib/db/agentBridgeState.ts");
const providers = await import("../../src/lib/db/providers.ts");
const routingContext = await import("../../src/mitm/agentBridgeRoutingContext.ts");

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createConnection(provider: string, providerSpecificData: Record<string, unknown>) {
  return providers.createProviderConnection({
    provider,
    authType: "oauth",
    name: `${provider}-binding`,
    email: `${provider}@example.test`,
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    providerSpecificData,
    isActive: true,
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("AgentBridge binding accepts a persisted Antigravity CLI connection without storing context", async () => {
  const connection = await createConnection("agy", { clientProfile: "cli" });
  assert.ok(connection && typeof connection.id === "string");

  await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", connection.id);

  assert.equal(
    await agentBridgeState.getAgentBridgeAntigravityConnection("antigravity"),
    connection.id
  );
  const row = core
    .getDbInstance()
    .prepare("SELECT * FROM agent_bridge_antigravity_connections WHERE agent_id = ?")
    .get("antigravity") as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ["agent_id", "connection_id", "updated_at"]);
});

test("verified AgentBridge assertion is accepted only for the current durable binding", async () => {
  const bound = await createConnection("agy", { clientProfile: "cli" });
  const sibling = await createConnection("antigravity", { clientProfile: "ide" });
  await agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", bound.id);

  const secret = "router-only-agent-bridge-secret";
  const assertion = routingContext.createAgentBridgeRoutingContextAssertion({
    secret,
    agent: "antigravity",
    connectionId: bound.id,
    path: "/v1/antigravity",
  });

  assert.equal(
    await agentBridgeState.resolveVerifiedAgentBridgeAntigravityConnection({
      agentId: "antigravity",
      connectionId:
        routingContext.verifyAgentBridgeRoutingContextAssertion({
          assertion,
          secret,
          agent: "antigravity",
          path: "/v1/antigravity",
        })?.connectionId ?? null,
    }),
    bound.id
  );
  assert.equal(
    await agentBridgeState.resolveVerifiedAgentBridgeAntigravityConnection({
      agentId: "antigravity",
      connectionId: sibling.id,
    }),
    null
  );
});

test("AgentBridge binding does not inherit combo resilience bypasses", () => {
  const chatSource = readFileSync(
    new URL("../../src/sse/handlers/chat.ts", import.meta.url),
    "utf8"
  );
  assert.match(chatSource, /isAgentBridgeRoutingContext/);
  assert.match(
    chatSource,
    /ignoreCircuitBreaker:\s*forceLiveComboTest\s*\|\|\s*\(hasForcedConnection\s*&&\s*!isAgentBridgeRoutingContext\)/
  );
  assert.match(
    chatSource,
    /ignoreModelCooldown:\s*forceLiveComboTest\s*\|\|\s*\(hasForcedConnection\s*&&\s*!isAgentBridgeRoutingContext\)/
  );
  assert.match(
    chatSource,
    /bypassCircuitBreaker:\s*forceLiveComboTest\s*\|\|\s*\(hasForcedConnection\s*&&\s*!isAgentBridgeRoutingContext\)/
  );
});

test("management MITM route exposes only durable connection ID after auth", () => {
  const routeSource = readFileSync(
    new URL("../../src/app/api/settings/mitm/route.ts", import.meta.url),
    "utf8"
  );
  const authIndex = routeSource.indexOf("const authError = await requireManagementAuth(request);");
  const bindingIndex = routeSource.indexOf(
    'setAgentBridgeAntigravityConnection("antigravity", parsed.data.antigravityConnectionId)'
  );
  assert.ok(authIndex >= 0 && bindingIndex > authIndex);
  assert.match(routeSource, /antigravityConnectionId/);
  assert.doesNotMatch(routeSource, /providerSpecificData/);
  assert.doesNotMatch(routeSource, /accessToken/);
});

test("AgentBridge binding rejects absent, non-Antigravity, and contextless connections", async () => {
  const missingContext = await createConnection("antigravity", {});
  const wrongProvider = await createConnection("openai", { clientProfile: "cli" });

  await assert.rejects(
    () => agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", "missing-connection"),
    /eligible Antigravity connection/
  );
  await assert.rejects(
    () => agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", missingContext.id),
    /eligible Antigravity connection/
  );
  await assert.rejects(
    () => agentBridgeState.setAgentBridgeAntigravityConnection("antigravity", wrongProvider.id),
    /eligible Antigravity connection/
  );
});
