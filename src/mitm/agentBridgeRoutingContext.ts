import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type RoutingContextClaims = {
  v: 1;
  aud: "omniroute-agent-bridge";
  agent: string;
  connectionId: string;
  path: string;
  iat: number;
  exp: number;
  nonce: string;
};

type CreateAgentBridgeRoutingContextAssertionOptions = {
  secret: string;
  agent: string;
  connectionId: string;
  path: string;
  now?: number;
};

type VerifyAgentBridgeRoutingContextAssertionOptions = {
  assertion: string | null | undefined;
  secret: string | null | undefined;
  agent: string;
  path: string;
  now?: number;
};

type VerifiedAgentBridgeRoutingContext = {
  connectionId: string;
};

const ASSERTION_TTL_MS = 60_000;
const MAX_ASSERTION_LENGTH = 2_048;
const usedNonces = new Map<string, number>();
let activeAgentBridgeRoutingContextSecret: string | null = null;
const verifiedRoutingContexts = new WeakMap<Request, string>();

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function sign(encodedClaims: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedClaims).digest("base64url");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseClaims(encodedClaims: string): RoutingContextClaims | null {
  const decoded = decode(encodedClaims);
  if (!decoded) return null;

  try {
    const value = JSON.parse(decoded) as Partial<RoutingContextClaims>;
    if (
      value.v !== 1 ||
      value.aud !== "omniroute-agent-bridge" ||
      !isNonEmptyString(value.agent) ||
      !isNonEmptyString(value.connectionId) ||
      !isNonEmptyString(value.path) ||
      !Number.isSafeInteger(value.iat) ||
      !Number.isSafeInteger(value.exp) ||
      !isNonEmptyString(value.nonce)
    ) {
      return null;
    }
    return value as RoutingContextClaims;
  } catch {
    return null;
  }
}

function consumeNonce(nonce: string, expiry: number, now: number): boolean {
  for (const [usedNonce, usedExpiry] of usedNonces) {
    if (usedExpiry <= now) usedNonces.delete(usedNonce);
  }
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, expiry);
  return true;
}

export function stripAgentBridgeRoutingContextAssertion(request: Request): Request {
  if (!request.headers.has("x-omniroute-agent-bridge-proof")) return request;
  const headers = new Headers(request.headers);
  headers.delete("x-omniroute-agent-bridge-proof");
  return new Request(request, { headers });
}

export function attachVerifiedAgentBridgeRoutingContext(
  request: Request,
  connectionId: string
): void {
  verifiedRoutingContexts.set(request, connectionId);
}

export function consumeVerifiedAgentBridgeRoutingContext(request: Request): string | null {
  const connectionId = verifiedRoutingContexts.get(request) ?? null;
  verifiedRoutingContexts.delete(request);
  return connectionId;
}

export function rotateAgentBridgeRoutingContextSecret(): string {
  activeAgentBridgeRoutingContextSecret = randomBytes(32).toString("base64url");
  usedNonces.clear();
  return activeAgentBridgeRoutingContextSecret;
}

export function verifyActiveAgentBridgeRoutingContextAssertion({
  assertion,
  agent,
  path,
}: Omit<
  VerifyAgentBridgeRoutingContextAssertionOptions,
  "secret"
>): VerifiedAgentBridgeRoutingContext | null {
  return verifyAgentBridgeRoutingContextAssertion({
    assertion,
    secret: activeAgentBridgeRoutingContextSecret,
    agent,
    path,
  });
}

export function createAgentBridgeRoutingContextAssertion({
  secret,
  agent,
  connectionId,
  path,
  now = Date.now(),
}: CreateAgentBridgeRoutingContextAssertionOptions): string {
  if (!isNonEmptyString(secret) || !isNonEmptyString(agent) || !isNonEmptyString(connectionId)) {
    throw new Error("AgentBridge routing context requires a secret, agent, and connection ID");
  }
  const claims: RoutingContextClaims = {
    v: 1,
    aud: "omniroute-agent-bridge",
    agent,
    connectionId,
    path,
    iat: now,
    exp: now + ASSERTION_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedClaims = encode(JSON.stringify(claims));
  return `${encodedClaims}.${sign(encodedClaims, secret)}`;
}

export function verifyAgentBridgeRoutingContextAssertion({
  assertion,
  secret,
  agent,
  path,
  now = Date.now(),
}: VerifyAgentBridgeRoutingContextAssertionOptions): VerifiedAgentBridgeRoutingContext | null {
  if (
    !isNonEmptyString(assertion) ||
    assertion.length > MAX_ASSERTION_LENGTH ||
    !isNonEmptyString(secret)
  ) {
    return null;
  }
  const parts = assertion.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [encodedClaims, signature] = parts;
  const expectedSignature = sign(encodedClaims, secret);
  const suppliedSignature = Buffer.from(signature, "utf8");
  const expectedSignatureBuffer = Buffer.from(expectedSignature, "utf8");
  if (
    suppliedSignature.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(suppliedSignature, expectedSignatureBuffer)
  ) {
    return null;
  }

  const claims = parseClaims(encodedClaims);
  if (
    !claims ||
    claims.agent !== agent ||
    claims.path !== path ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp - claims.iat > ASSERTION_TTL_MS
  ) {
    return null;
  }
  if (!consumeNonce(claims.nonce, claims.exp, now)) return null;

  return { connectionId: claims.connectionId };
}
