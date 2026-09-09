import { applyFingerprint, isCliCompatEnabled } from "../../config/cliFingerprints.ts";
import {
  assertAntigravityClientContextCompatible,
  type AntigravityClientContext,
} from "../../config/antigravityClient.ts";
import { scrubProxyAndFingerprintHeaders } from "../../services/antigravityHeaderScrub.ts";
import {
  generateAntigravityRequestId,
  getAntigravityEnvelopeUserAgent,
} from "../../services/antigravityIdentity.ts";

export type AntigravityRequestContractContext = {
  client: AntigravityClientContext;
  requestType: "agent" | "image_gen";
  upstreamModel: string;
  allowBodyProjectOverride: boolean;
};

/** Public fields understood by the Cloud Code prediction-service envelope. */
export const ANTIGRAVITY_ENVELOPE_FIELDS = new Set([
  "project",
  "requestId",
  "request",
  "model",
  "userPromptId",
  "userAgent",
  "requestType",
  "enabledCreditTypes",
]);

function cloneBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;

  let clone: unknown;
  try {
    clone = structuredClone(body);
  } catch {
    clone = JSON.parse(JSON.stringify(body));
  }

  if (clone && typeof clone === "object" && !Array.isArray(clone)) {
    delete (clone as Record<string, unknown>)._toolNameMap;
  }
  return clone;
}

function getToolNameMap(body: Record<string, unknown>): Map<string, string> | null {
  return body._toolNameMap instanceof Map ? body._toolNameMap : null;
}

function attachToolNameMap(
  body: Record<string, unknown>,
  toolNameMap: Map<string, string> | null
): Record<string, unknown> {
  if (toolNameMap) {
    Object.defineProperty(body, "_toolNameMap", {
      value: toolNameMap,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return body;
}

function getNonEmptyProject(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the one public Cloud Code envelope from a translated semantic request.
 *
 * The caller's object is cloned before the request is retained. Only fields in
 * the positive envelope contract are considered; client-only fields never leak
 * into the outer protobuf-shaped object. Billing fields are injected by the
 * credits policy after this function, not accepted from inbound client input.
 */
export function buildAntigravityEnvelope(
  translatedBody: Record<string, unknown>,
  context: AntigravityRequestContractContext
): Record<string, unknown> {
  assertAntigravityClientContextCompatible(context.client);
  // Project selection is performed by AntigravityExecutor before this helper.
  // The context flag remains part of the contract so project policy cannot be
  // accidentally omitted by future request builders.
  void context.allowBodyProjectOverride;

  const source = translatedBody && typeof translatedBody === "object" ? translatedBody : {};
  const toolNameMap =
    getToolNameMap(source) ??
    (source.request && typeof source.request === "object" && !Array.isArray(source.request)
      ? getToolNameMap(source.request as Record<string, unknown>)
      : null);
  const cloned = cloneBody(source) as Record<string, unknown>;
  const request =
    cloned.request && typeof cloned.request === "object" && !Array.isArray(cloned.request)
      ? cloned.request
      : {};
  const envelope: Record<string, unknown> = {
    project: getNonEmptyProject(source.project),
    requestId: generateAntigravityRequestId(),
    request,
    model: context.upstreamModel,
    userAgent: getAntigravityEnvelopeUserAgent(),
    requestType: context.requestType,
  };

  const userPromptId = source.userPromptId;
  if (typeof userPromptId === "string" && userPromptId.trim().length > 0) {
    envelope.userPromptId = userPromptId.trim();
  }

  return attachToolNameMap(envelope, toolNameMap);
}

function findHeaderKey(headers: Record<string, string>, name: string): string | null {
  const normalized = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalized) ?? null;
}

/**
 * Serialize a frozen semantic body with native scrubbing and optional CLI
 * ordering. Fingerprinting is opt-in; when disabled, only native scrubbing is
 * applied. When enabled, the fingerprint result is returned as-is so a later
 * header mutation cannot undo the captured order.
 */
export function serializeAntigravityRequest(
  provider: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  context?: AntigravityClientContext
): { headers: Record<string, string>; bodyString: string } {
  if (context) assertAntigravityClientContextCompatible(context);

  const nativeHeaders = scrubProxyAndFingerprintHeaders({ ...headers });
  const clonedBody = cloneBody(body);
  if (!isCliCompatEnabled(provider)) {
    return {
      headers: nativeHeaders,
      bodyString: JSON.stringify(clonedBody),
    };
  }

  const fingerprinted = applyFingerprint(provider, nativeHeaders, clonedBody);
  if (context) {
    // applyFingerprint has a generic Antigravity UA. Restore the already
    // selected profile value without deleting/reinserting the key, preserving
    // the fingerprint's final insertion order.
    const sourceUserAgentKey = findHeaderKey(headers, "user-agent");
    const resultUserAgentKey = findHeaderKey(fingerprinted.headers, "user-agent");
    if (sourceUserAgentKey && resultUserAgentKey) {
      fingerprinted.headers[resultUserAgentKey] = headers[sourceUserAgentKey];
    }
  }
  return fingerprinted;
}
