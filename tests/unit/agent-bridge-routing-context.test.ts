import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import {
  attachVerifiedAgentBridgeRoutingContext,
  consumeVerifiedAgentBridgeRoutingContext,
  createAgentBridgeRoutingContextAssertion,
  stripAgentBridgeRoutingContextAssertion,
  verifyAgentBridgeRoutingContextAssertion,
} from "../../src/mitm/agentBridgeRoutingContext.ts";

const require = createRequire(import.meta.url);
const {
  createChildAgentBridgeRoutingContextAssertion,
  stripAgentBridgeRoutingContextProofFromHeaders,
} = require("../../src/mitm/_internal/agentBridgeRoutingContext.cjs") as {
  createChildAgentBridgeRoutingContextAssertion: (input: {
    secret: string;
    agent: string;
    connectionId: string;
    path: string;
    now?: number;
  }) => string | null;
  stripAgentBridgeRoutingContextProofFromHeaders: (
    headers: Record<string, string | string[] | undefined>
  ) => Record<string, string | string[] | undefined>;
};

const SECRET = "agent-bridge-routing-context-test-secret";
const CONNECTION_ID = "antigravity-cli-connection";
const PATH = "/v1/antigravity";
const NOW = 1_700_000_000_000;

test("verified AgentBridge assertion selects only its bound connection once", () => {
  const assertion = createAgentBridgeRoutingContextAssertion({
    secret: SECRET,
    agent: "antigravity",
    connectionId: CONNECTION_ID,
    path: PATH,
    now: NOW,
  });

  const first = verifyAgentBridgeRoutingContextAssertion({
    assertion,
    secret: SECRET,
    agent: "antigravity",
    path: PATH,
    now: NOW + 1,
  });
  assert.equal(first?.connectionId, CONNECTION_ID);

  const replay = verifyAgentBridgeRoutingContextAssertion({
    assertion,
    secret: SECRET,
    agent: "antigravity",
    path: PATH,
    now: NOW + 2,
  });
  assert.equal(replay, null);
});

test("routing context proof is stripped from any request before processing", () => {
  const request = new Request("http://localhost/v1/chat/completions", {
    headers: { "x-omniroute-agent-bridge-proof": "forged-proof" },
  });

  const stripped = stripAgentBridgeRoutingContextAssertion(request);
  assert.equal(stripped.headers.get("x-omniroute-agent-bridge-proof"), null);
});

test("MITM diagnostics remove valid and forged routing proofs before capture", () => {
  const validProof = createChildAgentBridgeRoutingContextAssertion({
    secret: SECRET,
    agent: "antigravity",
    connectionId: CONNECTION_ID,
    path: PATH,
    now: NOW,
  });
  assert.ok(validProof);

  for (const proof of [validProof, "forged.routing-proof"]) {
    const headers = stripAgentBridgeRoutingContextProofFromHeaders({
      host: "cloudcode-pa.googleapis.com",
      "X-OmniRoute-Agent-Bridge-Proof": proof,
      "content-type": "application/json",
    });
    assert.equal(headers["X-OmniRoute-Agent-Bridge-Proof"], undefined);
    assert.equal(headers["x-omniroute-agent-bridge-proof"], undefined);
    assert.equal(headers.host, "cloudcode-pa.googleapis.com");
    assert.equal(headers["content-type"], "application/json");
  }
});

test("verified routing context is request-local and consumed once", () => {
  const request = new Request("http://localhost/v1/antigravity");
  attachVerifiedAgentBridgeRoutingContext(request, CONNECTION_ID);

  assert.equal(consumeVerifiedAgentBridgeRoutingContext(request), CONNECTION_ID);
  assert.equal(consumeVerifiedAgentBridgeRoutingContext(request), null);
});

test("standalone MITM child assertion verifies at the router boundary", () => {
  const assertion = createChildAgentBridgeRoutingContextAssertion({
    secret: SECRET,
    agent: "antigravity",
    connectionId: CONNECTION_ID,
    path: PATH,
    now: NOW,
  });

  assert.ok(assertion);
  assert.deepEqual(
    verifyAgentBridgeRoutingContextAssertion({
      assertion,
      secret: SECRET,
      agent: "antigravity",
      path: PATH,
      now: NOW + 1,
    }),
    { connectionId: CONNECTION_ID }
  );
});

test("AgentBridge assertion rejects tampered, expired, wrong-agent, and wrong-path inputs", () => {
  const assertion = createAgentBridgeRoutingContextAssertion({
    secret: SECRET,
    agent: "antigravity",
    connectionId: CONNECTION_ID,
    path: PATH,
    now: NOW,
  });
  const tampered = `${assertion.slice(0, -1)}${assertion.endsWith("a") ? "b" : "a"}`;

  assert.equal(
    verifyAgentBridgeRoutingContextAssertion({
      assertion: tampered,
      secret: SECRET,
      agent: "antigravity",
      path: PATH,
      now: NOW + 1,
    }),
    null
  );
  assert.equal(
    verifyAgentBridgeRoutingContextAssertion({
      assertion,
      secret: SECRET,
      agent: "wrong-agent",
      path: PATH,
      now: NOW + 1,
    }),
    null
  );
  assert.equal(
    verifyAgentBridgeRoutingContextAssertion({
      assertion,
      secret: SECRET,
      agent: "antigravity",
      path: "/v1/chat/completions",
      now: NOW + 1,
    }),
    null
  );
  assert.equal(
    verifyAgentBridgeRoutingContextAssertion({
      assertion,
      secret: SECRET,
      agent: "antigravity",
      path: PATH,
      now: NOW + 60_001,
    }),
    null
  );
});
