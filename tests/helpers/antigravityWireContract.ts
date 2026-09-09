import { createHash } from "node:crypto";

export type AntigravityProfileId = "cli" | "ide";

export type AntigravityObservedRequest = {
  method: string;
  url: string;
  httpVersion: string;
  headers: Array<[string, string]>;
  bodyUtf8: string;
};

export type AntigravityDynamicRule = {
  path: string;
  kind: "credential" | "timestamp" | "request-id" | "session-id" | "signature";
  format: "opaque" | "uuid" | "integer-string" | "iso-timestamp" | "hex";
  headerName?: string;
  scheme?: string;
};

export type AntigravityStructuralSummary = {
  method: string;
  path: string;
  bodyBytes: number;
  bodyKeys: readonly string[];
  headerNames: readonly string[];
};

export type AntigravityReferenceManifest = {
  contractId: string;
  profile: AntigravityProfileId;
  product: "agy-cli" | "antigravity-ide";
  clientVersion: string;
  platform: string;
  authMode: "consumer-oauth";
  binarySha256: string;
  capturedAt: string;
  source: "operator-approved-capture" | "synthetic-only";
  surfaces: readonly ("oauth" | "bootstrap" | "content" | "usage" | "credits" | "image" | "mitm")[];
  dynamicRules: readonly AntigravityDynamicRule[];
};

export type WireDifference = {
  path: string;
  category: "http" | "header" | "body" | "lifecycle" | "transport";
  reason: string;
};

/** Compatibility names retained for older synthetic comparator callers. */
export type ObservedRequest = AntigravityObservedRequest;
export type DynamicRule = AntigravityDynamicRule | LegacyDynamicRule;

type LegacyDynamicRule = {
  path: string;
  kind: AntigravityDynamicRule["kind"];
  format?: AntigravityDynamicRule["format"];
  headerName?: string;
  scheme?: string;
};

type ScalarSpan = {
  start: number;
  end: number;
  value: unknown;
};

type ScalarIndex = {
  spans: Map<string, ScalarSpan[]>;
  paths: Set<string>;
  ambiguous: Set<string>;
};

const DYNAMIC_KINDS = new Set<AntigravityDynamicRule["kind"]>([
  "credential",
  "timestamp",
  "request-id",
  "session-id",
  "signature",
]);
const DYNAMIC_FORMATS = new Set<AntigravityDynamicRule["format"]>([
  "opaque",
  "uuid",
  "integer-string",
  "iso-timestamp",
  "hex",
]);
const JSON_TOKEN =
  /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REDACTED = /^(?:\[redacted\]|\[masked\]|<redacted>|<masked>|redacted|masked)$/i;
const SENSITIVE_NAME =
  /authorization|proxyauthorization|cookie|setcookie|token|secret|apikey|prompt|machineid|session/i;
const RAW_ARTIFACT_CONTAINER =
  /^(?:body|body[-_]?utf8|request|response|observations?|rpc[-_]?results?|logs?|raw(?:[-_]?request|[-_]?response|[-_]?headers?))$/i;
const STRUCTURAL_DIGEST_PREFIX = "structural-sha256:";

function difference(
  differences: WireDifference[],
  path: string,
  category: WireDifference["category"],
  reason: string
): void {
  differences.push({ path, category, reason });
}

function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isStructuralSummary(value: unknown): value is AntigravityStructuralSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AntigravityStructuralSummary> & Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !["method", "path", "bodyBytes", "bodyKeys", "headerNames"].includes(key)
    )
  )
    return false;
  return (
    typeof candidate.method === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.bodyBytes === "number" &&
    Number.isSafeInteger(candidate.bodyBytes) &&
    candidate.bodyBytes >= 0 &&
    Array.isArray(candidate.bodyKeys) &&
    candidate.bodyKeys.every((key) => typeof key === "string") &&
    Array.isArray(candidate.headerNames) &&
    candidate.headerNames.every((name) => typeof name === "string")
  );
}

function stableStructuralSummary(summary: AntigravityStructuralSummary): string {
  if (!isStructuralSummary(summary)) {
    throw new Error("Invalid Antigravity structural summary");
  }
  return JSON.stringify({
    method: summary.method,
    path: summary.path,
    bodyBytes: summary.bodyBytes,
    bodyKeys: [...summary.bodyKeys].sort(),
    headerNames: [...summary.headerNames].map((name) => name.toLowerCase()).sort(),
  });
}

export function createAntigravityStructuralDigest(summary: AntigravityStructuralSummary): string {
  return `${STRUCTURAL_DIGEST_PREFIX}${createHash("sha256")
    .update(stableStructuralSummary(summary), "utf8")
    .digest("hex")}`;
}

function parseJsonScalars(body: string): ScalarIndex | undefined {
  try {
    JSON.parse(body);
  } catch {
    return undefined;
  }

  const tokens = Array.from(body.matchAll(JSON_TOKEN), (match) => ({
    raw: match[0],
    start: match.index ?? 0,
  }));
  let cursor = 0;
  const spans = new Map<string, ScalarSpan[]>();
  const paths = new Set<string>();
  const duplicatePaths = new Set<string>();

  const currentToken = (): (typeof tokens)[number] | undefined => tokens[cursor];
  const consume = (raw?: string): (typeof tokens)[number] => {
    const token = currentToken();
    if (!token || (raw !== undefined && token.raw !== raw)) {
      throw new Error("invalid JSON token stream");
    }
    cursor += 1;
    return token;
  };

  const visit = (path: string): void => {
    const token = currentToken();
    if (!token) throw new Error("invalid JSON token stream");
    paths.add(path);

    if (token.raw === "{" || token.raw === "[") {
      const object = token.raw === "{";
      const close = object ? "}" : "]";
      consume(token.raw);
      const childKeys = new Set<string>();
      let index = 0;
      if (currentToken()?.raw === close) {
        consume(close);
        return;
      }
      while (true) {
        let key: string;
        if (object) {
          const keyToken = consume();
          if (!keyToken.raw.startsWith('"')) throw new Error("invalid JSON token stream");
          key = JSON.parse(keyToken.raw) as string;
          consume(":");
        } else {
          key = String(index++);
        }
        const childPath = `${path}/${pointerToken(key)}`;
        if (childKeys.has(key)) duplicatePaths.add(childPath);
        childKeys.add(key);
        visit(childPath);
        if (currentToken()?.raw === close) {
          consume(close);
          return;
        }
        consume(",");
      }
    }

    const scalar = consume();
    let value: unknown;
    try {
      value = JSON.parse(scalar.raw);
    } catch {
      throw new Error("invalid JSON token stream");
    }
    const entries = spans.get(path) ?? [];
    entries.push({ start: scalar.start, end: scalar.start + scalar.raw.length, value });
    spans.set(path, entries);
  };

  try {
    visit("/body");
    if (cursor !== tokens.length) return undefined;
  } catch {
    return undefined;
  }

  const ambiguous = new Set<string>();
  for (const duplicate of duplicatePaths) {
    for (const path of paths) {
      if (path === duplicate || path.startsWith(`${duplicate}/`)) ambiguous.add(path);
    }
  }
  return { spans, paths, ambiguous };
}

function unescapePointer(pointer: string): string[] | undefined {
  if (pointer === "/body") return [];
  if (!pointer.startsWith("/body/")) return undefined;
  const suffix = pointer.slice("/body/".length);
  if (suffix.includes("*")) return undefined;
  const parts = suffix.split("/");
  if (parts.some((part) => /~(?![01])/.test(part))) return undefined;
  return parts.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolveJsonPath(index: ScalarIndex, path: string): ScalarSpan[] | undefined {
  if (!unescapePointer(path)) return undefined;
  return index.spans.get(path);
}

function dynamicShape(
  value: unknown,
  rule: Pick<AntigravityDynamicRule, "kind" | "format">
): string | undefined {
  if (rule.kind === "timestamp" && rule.format === "opaque") {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0)
      return "timestamp-integer";
    if (typeof value === "string" && /^\d+$/.test(value)) return "timestamp-integer-string";
    if (
      typeof value === "string" &&
      ISO_TIMESTAMP.test(value) &&
      Number.isFinite(Date.parse(value))
    ) {
      return "timestamp-iso";
    }
    return undefined;
  }
  if ((rule.kind === "request-id" || rule.kind === "session-id") && rule.format === "opaque") {
    if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
      return undefined;
    }
    if (UUID.test(value)) return "uuid";
    if (/^agent\/\d+\/[0-9a-f]{8}$/i.test(value)) return "agent-id";
    return value.replace(/[A-Za-z]+/g, "A").replace(/\d+/g, "0");
  }
  switch (rule.format) {
    case "opaque": {
      if (typeof value !== "string" || value.length === 0) return undefined;
      if (rule.kind === "credential") {
        const match = /^(?:([A-Za-z][A-Za-z0-9_-]*) )?([A-Za-z0-9._~+\/-=]+)$/.exec(value);
        if (!match || !match[2]) return undefined;
        return `credential:${match[1] ?? "opaque"}`;
      }
      if (rule.kind === "signature") {
        return /^[A-Za-z0-9._~+\/-=]+$/.test(value) ? "opaque-signature" : undefined;
      }
      return "opaque";
    }
    case "uuid":
      return typeof value === "string" && UUID.test(value) ? "uuid" : undefined;
    case "integer-string":
      return typeof value === "string" && /^\d+$/.test(value) ? "integer-string" : undefined;
    case "iso-timestamp":
      return typeof value === "string" &&
        ISO_TIMESTAMP.test(value) &&
        Number.isFinite(Date.parse(value))
        ? "iso-timestamp"
        : undefined;
    case "hex":
      return typeof value === "string" && /^[0-9a-f]+$/i.test(value) ? "hex" : undefined;
    default:
      return undefined;
  }
}

function isHeaderRule(path: string): RegExpExecArray | undefined {
  return /^\/headers\/(0|[1-9]\d*)\/1$/.exec(path);
}

function isValidRulePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("*")) return false;
  if (/~(?![01])/.test(path)) return false;
  const header = isHeaderRule(path);
  if (header) return true;
  return unescapePointer(path) !== undefined;
}

function maskScalars(body: string, spans: ScalarSpan[]): string {
  let masked = body;
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    // NUL cannot occur literally inside a valid JSON string token.
    masked = `${masked.slice(0, span.start)}\0${masked.slice(span.end)}`;
  }
  return masked;
}

function isRedactionMarker(value: unknown): boolean {
  return typeof value === "string" && REDACTED.test(value);
}

function isSensitiveName(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_NAME.test(normalized);
}

function assertRedactedValue(value: unknown, path: string): void {
  if (value === null || value === undefined || isRedactionMarker(value)) return;
  throw new Error(`Antigravity artifact contains an unredacted sensitive value at ${path}`);
}

/**
 * Reject raw credentials, prompts, identifiers, and complete wire artifacts.
 * This intentionally accepts structural summaries and explicit redaction markers only.
 */
export function assertRedactedAntigravityArtifact(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string, key?: string): void => {
    if (key && RAW_ARTIFACT_CONTAINER.test(key)) {
      throw new Error(`Antigravity artifact contains an unredacted wire payload at ${path}`);
    }
    if (key && /^structuralDigest$/i.test(key)) {
      const root =
        value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
      const summary = root?.requestSummary;
      if (
        typeof current !== "string" ||
        !isStructuralSummary(summary) ||
        current !== createAntigravityStructuralDigest(summary)
      ) {
        throw new Error(`Antigravity artifact contains an invalid structural digest at ${path}`);
      }
      return;
    }
    if (key && isSensitiveName(key)) {
      assertRedactedValue(current, path);
      return;
    }
    if (current === null || current === undefined || typeof current !== "object") return;
    if (seen.has(current)) throw new Error(`Antigravity artifact is circular at ${path}`);
    seen.add(current);

    if (Array.isArray(current)) {
      if (current.length === 2 && typeof current[0] === "string" && isSensitiveName(current[0])) {
        assertRedactedValue(current[1], `${path}/1`);
        return;
      }
      current.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }

    for (const [childKey, childValue] of Object.entries(current)) {
      visit(childValue, `${path}/${childKey}`, childKey);
    }
  };
  visit(value, "$");
}

/**
 * Compare an observed request without normalizing away wire-level differences.
 * Dynamic rules authorize only scalar substitutions whose declared syntax is valid;
 * they never become an ignore list. All diagnostics are value-free.
 */
export function compareObservedRequests(
  expected: AntigravityObservedRequest,
  actual: AntigravityObservedRequest,
  dynamicRules: readonly (AntigravityDynamicRule | LegacyDynamicRule)[] = []
): WireDifference[] {
  const differences: WireDifference[] = [];
  const expectedJson = parseJsonScalars(expected.bodyUtf8);
  const actualJson = parseJsonScalars(actual.bodyUtf8);
  const expectedMask: ScalarSpan[] = [];
  const actualMask: ScalarSpan[] = [];
  const dynamicHeaders = new Set<number>();
  const seenRules = new Set<string>();

  for (const rawRule of dynamicRules as readonly unknown[]) {
    if (!rawRule || typeof rawRule !== "object") {
      difference(differences, "/dynamicRules", "body", "Dynamic rule is malformed");
      continue;
    }
    const rule = rawRule as Partial<AntigravityDynamicRule>;
    const path = rule.path;
    const kind = rule.kind;
    const format = rule.format ?? "opaque";
    const rulePath = typeof path === "string" && path.length > 0 ? path : "/dynamicRules";
    if (
      typeof path !== "string" ||
      !isValidRulePath(path) ||
      typeof kind !== "string" ||
      !DYNAMIC_KINDS.has(kind as AntigravityDynamicRule["kind"]) ||
      typeof format !== "string" ||
      !DYNAMIC_FORMATS.has(format as AntigravityDynamicRule["format"]) ||
      seenRules.has(path)
    ) {
      difference(differences, rulePath, "body", "Dynamic rule is invalid or duplicated");
      continue;
    }
    seenRules.add(path);

    const header = isHeaderRule(path);
    if (header) {
      const index = Number(header[1]);
      const expectedHeader = expected.headers[index];
      const actualHeader = actual.headers[index];
      if (!expectedHeader || !actualHeader) {
        difference(differences, path, "header", "Dynamic header occurrence is missing");
        continue;
      }
      const headerName =
        typeof rule.headerName === "string" ? rule.headerName.toLowerCase() : undefined;
      const expectedName = expectedHeader[0].toLowerCase();
      const actualName = actualHeader[0].toLowerCase();
      const expectedScheme = typeof rule.scheme === "string" ? rule.scheme : undefined;
      const expectedValueScheme = expectedHeader[1].split(/\s+/, 1)[0];
      const actualValueScheme = actualHeader[1].split(/\s+/, 1)[0];
      if (
        !headerName ||
        expectedName !== headerName ||
        actualName !== headerName ||
        (expectedScheme !== undefined &&
          (expectedValueScheme !== expectedScheme || actualValueScheme !== expectedScheme))
      ) {
        difference(differences, path, "header", "Dynamic header identity differs");
        continue;
      }
      const expectedShape = dynamicShape(expectedHeader[1], { kind, format });
      const actualShape = dynamicShape(actualHeader[1], { kind, format });
      if (!expectedShape || !actualShape || expectedShape !== actualShape) {
        difference(differences, path, "header", "Dynamic header value has invalid syntax");
      }
      dynamicHeaders.add(index);
      continue;
    }

    const pointer = unescapePointer(path);
    if (!pointer || !expectedJson || !actualJson) {
      difference(differences, path, "body", "Dynamic path cannot resolve in an opaque body");
      continue;
    }
    const expectedPath = path;
    const expectedSpans = resolveJsonPath(expectedJson, expectedPath);
    const actualSpans = resolveJsonPath(actualJson, expectedPath);
    if (
      !expectedSpans ||
      expectedSpans.length !== 1 ||
      !actualSpans ||
      actualSpans.length !== 1 ||
      expectedJson.ambiguous.has(expectedPath) ||
      actualJson.ambiguous.has(expectedPath)
    ) {
      difference(differences, path, "body", "Dynamic path is unknown or not a unique scalar");
      continue;
    }
    const expectedShape = dynamicShape(expectedSpans[0].value, { kind, format });
    const actualShape = dynamicShape(actualSpans[0].value, { kind, format });
    if (!expectedShape || !actualShape || expectedShape !== actualShape) {
      difference(differences, path, "body", "Dynamic scalar has invalid syntax");
      continue;
    }
    expectedMask.push(expectedSpans[0]);
    actualMask.push(actualSpans[0]);
  }

  if (expected.method !== actual.method) {
    difference(differences, "/method", "http", "HTTP method differs");
  }
  if (expected.url !== actual.url) {
    difference(differences, "/url", "http", "URL or query differs");
  }
  if (expected.httpVersion !== actual.httpVersion) {
    difference(differences, "/httpVersion", "http", "HTTP version differs");
  }

  if (expected.headers.length !== actual.headers.length) {
    difference(differences, "/headers", "header", "Header occurrence count differs");
  }
  for (
    let index = 0;
    index < Math.min(expected.headers.length, actual.headers.length);
    index += 1
  ) {
    const expectedName = expected.headers[index]?.[0].toLowerCase();
    const actualName = actual.headers[index]?.[0].toLowerCase();
    if (expectedName !== actualName) {
      difference(
        differences,
        `/headers/${index}/0`,
        "header",
        "Header name or occurrence order differs"
      );
    }
    if (!dynamicHeaders.has(index) && expected.headers[index]?.[1] !== actual.headers[index]?.[1]) {
      difference(differences, `/headers/${index}/1`, "header", "Header value differs");
    }
  }

  const maskedExpected = expectedJson
    ? maskScalars(expected.bodyUtf8, expectedMask)
    : expected.bodyUtf8;
  const maskedActual = actualJson ? maskScalars(actual.bodyUtf8, actualMask) : actual.bodyUtf8;
  if (maskedExpected !== maskedActual) {
    difference(
      differences,
      "/bodyUtf8",
      "body",
      "Serialized body differs outside approved dynamic scalars"
    );
  }
  return differences;
}
