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
