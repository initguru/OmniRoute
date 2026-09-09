const { createHmac, randomBytes } = require("node:crypto");

const ASSERTION_TTL_MS = 60_000;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function createChildAgentBridgeRoutingContextAssertion({
  secret,
  agent,
  connectionId,
  path,
  now = Date.now(),
}) {
  if (
    !isNonEmptyString(secret) ||
    !isNonEmptyString(agent) ||
    !isNonEmptyString(connectionId) ||
    !isNonEmptyString(path)
  ) {
    return null;
  }
  const claims = {
    v: 1,
    aud: "omniroute-agent-bridge",
    agent,
    connectionId,
    path,
    iat: now,
    exp: now + ASSERTION_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedClaims).digest("base64url");
  return `${encodedClaims}.${signature}`;
}

function stripAgentBridgeRoutingContextProofFromHeaders(headers) {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() !== "x-omniroute-agent-bridge-proof") sanitized[name] = value;
  }
  return sanitized;
}

function createChildAgentBridgeRoutingContextAssertionFromEnvironment({ path, agent }) {
  return createChildAgentBridgeRoutingContextAssertion({
    secret: process.env.AGENT_BRIDGE_ROUTING_CONTEXT_SECRET || "",
    agent,
    connectionId: process.env.AGENT_BRIDGE_ANTIGRAVITY_CONNECTION_ID || "",
    path,
  });
}

module.exports = {
  createChildAgentBridgeRoutingContextAssertion,
  createChildAgentBridgeRoutingContextAssertionFromEnvironment,
  stripAgentBridgeRoutingContextProofFromHeaders,
};
