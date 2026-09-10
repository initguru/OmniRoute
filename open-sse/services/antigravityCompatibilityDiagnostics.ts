import { createHash } from "node:crypto";
import type {
  AntigravityClientContext,
  AntigravityVersionState,
} from "../config/antigravityClient.ts";

export type AntigravityCompatibilityErrorClass =
  | "schema_rejection"
  | "auth_failure"
  | "project_route"
  | "geo_eligibility"
  | "quota_rate_limit"
  | "transport"
  | "version_compatibility"
  | "unknown";

export type AntigravityCompatibilityEvent = {
  event: "antigravity.compatibility.request";
  provider: string;
  profile: "cli" | "ide";
  observedVersion: string | null;
  versionState: AntigravityVersionState;
  contractId: string;
  surface: "oauth" | "bootstrap" | "content" | "usage" | "credits" | "image" | "mitm";
  requestType: "agent" | "image_gen" | null;
  attempt: number;
  errorClass: AntigravityCompatibilityErrorClass | null;
  retryDecision:
    "none" | "bounded_retry" | "project_header_retry" | "credits_retry" | "refresh_retry";
  redactedBodyDigest: string | null;
  redactedHeaderDigest: string | null;
  durationMs: number;
};

type BodyShapeSummary = {
  requestType: "agent" | "image_gen" | null;
  modelFamily: string | null;
  stream: boolean | null;
  contents: number;
  parts: number;
  tools: number;
  toolDeclarations: number;
  fields: string[];
  fieldTypes: Record<string, string>;
};

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-goog-user-project",
  "x-api-key",
]);

const ALLOWED_BODY_FIELDS = new Set([
  "contents",
  "generationconfig",
  "safetysettings",
  "sessionid",
  "systeminstruction",
  "toolconfig",
  "tools",
  "requesttype",
  "stream",
  "model",
]);

function hashStructuralSummary(summary: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(summary)).digest("hex")}`;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getModelFamily(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const model = value.trim().toLowerCase();
  if (model.includes("claude")) return "claude";
  if (model.includes("gemini")) return "gemini";
  if (model.includes("image")) return "image";
  if (model.includes("gpt")) return "gpt";
  if (model.includes("pro")) return "pro";
  if (model.includes("flash")) return "flash";
  return "other";
}

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function getFieldType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value === "object" ? "object" : typeof value;
}

function summarizeBodyShape(bodyShape: unknown): BodyShapeSummary {
  const root = getRecord(bodyShape) ?? {};
  const request = getRecord(root.request) ?? root;
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const toolDeclarations = tools.reduce((count, tool) => {
    const record = getRecord(tool);
    const declarations = record?.functionDeclarations;
    return count + getArrayLength(declarations);
  }, 0);
  const parts = contents.reduce((count, content) => {
    return count + getArrayLength(getRecord(content)?.parts);
  }, 0);
  const fields = Object.keys(request)
    .map((key) => key.toLowerCase())
    .filter((key) => ALLOWED_BODY_FIELDS.has(key))
    .sort();
  const fieldTypes: Record<string, string> = {};
  for (const field of fields) {
    const originalKey = Object.keys(request).find((key) => key.toLowerCase() === field);
    if (originalKey) fieldTypes[field] = getFieldType(request[originalKey]);
  }

  return {
    requestType:
      root.requestType === "image_gen" || request.requestType === "image_gen"
        ? "image_gen"
        : root.requestType === "agent" || request.requestType === "agent"
          ? "agent"
          : null,
    modelFamily: getModelFamily(root.model ?? request.model),
    stream: typeof root.stream === "boolean" ? root.stream : null,
    contents: contents.length,
    parts,
    tools: tools.length,
    toolDeclarations,
    fields,
    fieldTypes,
  };
}

function summarizeHeaderNames(headerNames: readonly string[]): string[] {
  const names = new Set<string>();
  for (const value of headerNames) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (!normalized || SENSITIVE_HEADER_NAMES.has(normalized)) continue;
    names.add(normalized);
  }
  return [...names].sort();
}

export function buildAntigravityCompatibilityEvent(input: {
  context: AntigravityClientContext;
  surface: AntigravityCompatibilityEvent["surface"];
  requestType?: AntigravityCompatibilityEvent["requestType"];
  attempt: number;
  errorClass?: AntigravityCompatibilityErrorClass | null;
  retryDecision: AntigravityCompatibilityEvent["retryDecision"];
  bodyShape?: unknown;
  headerNames?: readonly string[];
  durationMs: number;
  provider?: string;
}): AntigravityCompatibilityEvent {
  const bodySummary = input.bodyShape === undefined ? null : summarizeBodyShape(input.bodyShape);
  const headerSummary =
    input.headerNames === undefined ? null : summarizeHeaderNames(input.headerNames);
  return {
    event: "antigravity.compatibility.request",
    provider: input.provider?.trim() || "antigravity",
    profile: input.context.profile,
    observedVersion: input.context.observedVersion,
    versionState: input.context.versionState,
    contractId: input.context.contractId,
    surface: input.surface,
    requestType: input.requestType ?? bodySummary?.requestType ?? null,
    attempt: Number.isFinite(input.attempt) ? Math.max(0, Math.floor(input.attempt)) : 0,
    errorClass: input.errorClass ?? null,
    retryDecision: input.retryDecision,
    redactedBodyDigest: bodySummary ? hashStructuralSummary(bodySummary) : null,
    redactedHeaderDigest: headerSummary ? hashStructuralSummary(headerSummary) : null,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.floor(input.durationMs)) : 0,
  };
}

export function logAntigravityCompatibilityEvent(
  log: { debug?: (tag: string, message: string) => void },
  event: AntigravityCompatibilityEvent
): void {
  log.debug?.("AG_COMPATIBILITY", JSON.stringify(event));
}

export type AntigravityAttemptBaseline = {
  profile: "cli" | "ide";
  contractId: string;
  surface: AntigravityCompatibilityEvent["surface"];
  requestType: AntigravityCompatibilityEvent["requestType"];
  bodyDigest: string | null;
  headerDigest: string | null;
};

export type AntigravityDriftType =
  | "retry_body_drift"
  | "version_drift"
  | "schema_rejection"
  | "contract_unverified"
  | "none";

export type AntigravityCompatibilityAssessment = {
  driftType: AntigravityDriftType;
  shouldWarn: boolean;
  event: AntigravityCompatibilityEvent;
  baseline: AntigravityAttemptBaseline | null;
  reason: string;
};

export function createAntigravityAttemptBaseline(
  event: AntigravityCompatibilityEvent
): AntigravityAttemptBaseline {
  return {
    profile: event.profile,
    contractId: event.contractId,
    surface: event.surface,
    requestType: event.requestType,
    bodyDigest: event.redactedBodyDigest,
    headerDigest: event.redactedHeaderDigest,
  };
}

export function assessAntigravityCompatibilityEvent(
  event: AntigravityCompatibilityEvent,
  baseline?: AntigravityAttemptBaseline | null
): AntigravityCompatibilityAssessment {
  const resolvedBaseline = baseline ?? null;

  // 1. retry_body_drift: 동일 sendAntigravityRequest 실행 내 retry (attempt > 1 또는 retryDecision !== "none")에서
  // initial attempt와 body digest 불일치 시 분류.
  const isRetry = event.attempt > 1 || event.retryDecision !== "none";
  if (
    isRetry &&
    resolvedBaseline &&
    resolvedBaseline.bodyDigest !== null &&
    event.redactedBodyDigest !== null &&
    resolvedBaseline.bodyDigest !== event.redactedBodyDigest
  ) {
    return {
      driftType: "retry_body_drift",
      shouldWarn: true,
      event,
      baseline: resolvedBaseline,
      reason: `Retry body digest drift: initial=${resolvedBaseline.bodyDigest} current=${event.redactedBodyDigest}`,
    };
  }

  // 2. version_drift: event.versionState === "drift" 시 분류.
  if (event.versionState === "drift") {
    return {
      driftType: "version_drift",
      shouldWarn: true,
      event,
      baseline: resolvedBaseline,
      reason: `Observed client version is in drift state (observed=${event.observedVersion})`,
    };
  }

  // 3. schema_rejection: errorClass === "schema_rejection" or "schema" 시 분류.
  if (event.errorClass === "schema_rejection" || (event.errorClass as string) === "schema") {
    return {
      driftType: "schema_rejection",
      shouldWarn: true,
      event,
      baseline: resolvedBaseline,
      reason: `Upstream rejected request schema (profile=${event.profile}, surface=${event.surface})`,
    };
  }

  // 4. contract_unverified: contract가 unverified/synthetic 상태일 때.
  const isSyntheticContract =
    event.contractId.includes("synthetic") || event.versionState === "unverified";
  if (isSyntheticContract) {
    return {
      driftType: "contract_unverified",
      shouldWarn: false,
      event,
      baseline: resolvedBaseline,
      reason: `Contract unverified or synthetic baseline in use (contractId=${event.contractId})`,
    };
  }

  return {
    driftType: "none",
    shouldWarn: false,
    event,
    baseline: resolvedBaseline,
    reason: "No drift detected",
  };
}

const DRIFT_WARN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DRIFT_WARN_MAX_ENTRIES = 256;
const driftWarnDedupeMap = new Map<string, number>();

export function _resetAntigravityDriftDedupeForTest(): void {
  driftWarnDedupeMap.clear();
}

function buildDedupeKey(assessment: AntigravityCompatibilityAssessment): string {
  const { event, driftType } = assessment;
  return `${event.provider}:${event.profile}:${event.contractId}:${event.surface}:${driftType}:${event.redactedBodyDigest ?? "none"}`;
}

export function logAntigravityCompatibilityAssessment(
  log: { debug?: (tag: string, message: string) => void; warn?: (tag: string, message: string) => void },
  assessment: AntigravityCompatibilityAssessment
): void {
  // Always maintain existing AG_COMPATIBILITY debug logging
  logAntigravityCompatibilityEvent(log, assessment.event);

  if (!assessment.shouldWarn) return;

  const now = Date.now();
  const key = buildDedupeKey(assessment);

  // Check TTL
  const lastWarnTime = driftWarnDedupeMap.get(key);
  if (lastWarnTime !== undefined && now - lastWarnTime < DRIFT_WARN_TTL_MS) {
    // Deduplicated - update position for LRU
    driftWarnDedupeMap.delete(key);
    driftWarnDedupeMap.set(key, lastWarnTime);
    return;
  }

  // Enforce max 256 entries LRU
  if (driftWarnDedupeMap.size >= DRIFT_WARN_MAX_ENTRIES) {
    // First prune expired entries
    for (const [k, ts] of driftWarnDedupeMap) {
      if (now - ts >= DRIFT_WARN_TTL_MS) {
        driftWarnDedupeMap.delete(k);
      }
    }
    // If still at or over capacity, delete oldest (first key in Map)
    if (driftWarnDedupeMap.size >= DRIFT_WARN_MAX_ENTRIES) {
      const oldestKey = driftWarnDedupeMap.keys().next().value;
      if (oldestKey !== undefined) {
        driftWarnDedupeMap.delete(oldestKey);
      }
    }
  }

  driftWarnDedupeMap.set(key, now);

  const warnPayload = {
    warning: "Antigravity compatibility drift detected",
    driftType: assessment.driftType,
    provider: assessment.event.provider,
    profile: assessment.event.profile,
    contractId: assessment.event.contractId,
    surface: assessment.event.surface,
    requestType: assessment.event.requestType,
    attempt: assessment.event.attempt,
    retryDecision: assessment.event.retryDecision,
    observedVersion: assessment.event.observedVersion,
    versionState: assessment.event.versionState,
    errorClass: assessment.event.errorClass,
    bodyDigest: assessment.event.redactedBodyDigest,
    baselineBodyDigest: assessment.baseline?.bodyDigest ?? null,
    reason: assessment.reason,
  };

  log.warn?.("AG_COMPATIBILITY_DRIFT", JSON.stringify(warnPayload));
}

