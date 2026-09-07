export type ObservedRequest = {
  method: string;
  url: string;
  httpVersion: string;
  headers: Array<[string, string]>;
  bodyUtf8: string;
};
export type WireDifference = {
  path: string;
  category: "http" | "header" | "body" | "lifecycle" | "transport";
  reason: string;
};
export type DynamicRule = {
  path: string;
  kind: "credential" | "timestamp" | "request-id" | "session-id" | "signature";
};
type ScalarSpan = { start: number; end: number; value: unknown };

const invalidRule = (): never => {
  throw new Error("Invalid dynamic rule: use a unique, resolved scalar path and supported kind");
};
const pointerToken = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

// JSON.parse validates syntax; this scanner retains original token offsets instead
// of reserializing JSON (which would hide whitespace, key order and number spelling).
function scalarSpans(body: string): Map<string, ScalarSpan[]> {
  try {
    JSON.parse(body);
  } catch {
    return new Map();
  }
  const tokens = Array.from(
    body.matchAll(
      /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g
    )
  );
  const spans = new Map<string, ScalarSpan[]>();
  const containers = new Set<string>();
  const ambiguous = new Set<string>();
  let cursor = 0;
  function visit(path: string): void {
    const token = tokens[cursor++];
    if (token[0] === "{" || token[0] === "[") {
      if (containers.has(path) || spans.has(path)) ambiguous.add(path);
      containers.add(path);
      const object = token[0] === "{";
      const close = object ? "}" : "]";
      let index = 0;
      while (tokens[cursor][0] !== close) {
        let key = String(index++);
        if (object) {
          key = JSON.parse(tokens[cursor++][0]) as string;
          cursor++; // colon
        }
        visit(`${path}/${pointerToken(key)}`);
        if (tokens[cursor][0] === ",") cursor++;
      }
      cursor++;
    } else {
      if (containers.has(path) || spans.has(path)) ambiguous.add(path);
      const entries = spans.get(path) ?? [];
      entries.push({
        start: token.index!,
        end: token.index! + token[0].length,
        value: JSON.parse(token[0]),
      });
      spans.set(path, entries);
    }
  }
  visit("/body");
  // Duplicate object keys make the entire descendant subtree ambiguous.
  for (const path of spans.keys()) {
    if ([...ambiguous].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
      spans.delete(path);
  }
  return spans;
}

function shape(value: unknown, kind: DynamicRule["kind"]): string | undefined {
  if (kind === "timestamp") {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Number.isInteger(value) ? "integer" : "fraction";
    }
    if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value))
    ) {
      return value.replace(/\d/g, "0");
    }
    return undefined;
  }
  if (typeof value !== "string" || !value) return undefined;
  if (kind === "credential") {
    const credential = /^(?:([A-Za-z][A-Za-z0-9_-]*) )?([A-Za-z0-9._~+\/=-]+)$/.exec(value);
    return credential ? `credential:${credential[1] ?? "opaque"}` : undefined;
  }
  if (kind === "signature") {
    return /^[A-Za-z0-9._~+\/=-]+$/.test(value) ? "opaque-signature" : undefined;
  }
  if (/^agent\/\d+\/[0-9a-f]{8}$/.test(value)) return "agent/timestamp/hex8";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    return "uuid";
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) return undefined;
  return value.replace(/[A-Za-z]+/g, "A").replace(/[0-9]+/g, "0");
}

/**
 * Rule paths: /headers/<zero-based occurrence>/1 or /body followed by an RFC
 * 6901 JSON Pointer (including /body for a scalar root). Header indexes and array
 * indexes are canonical decimals; header names cannot be dynamic. No wildcards.
 * Rules must resolve to exactly one scalar in both requests; malformed, duplicate,
 * missing, container, or ambiguous duplicate-key paths throw a value-free error.
 *
 * Dynamic checks are syntax-only: credentials preserve an optional auth scheme;
 * signatures are nonempty opaque tokens; IDs preserve letter/digit runs and
 * separators; timestamps preserve numeric kind or ISO spelling shape. Lengths,
 * signature validity, ID uniqueness, and conversation/retry lifecycle relationships
 * require separate multi-request evidence. This function proves none of those.
 * All bytes outside approved scalar tokens remain exact, including JSON formatting.
 * It compares the recorded HTTP version, not TLS or unrecorded transport behavior.
 */
export function compareObservedRequests(
  expected: ObservedRequest,
  actual: ObservedRequest,
  dynamicRules: readonly DynamicRule[]
): WireDifference[] {
  const differences: WireDifference[] = [];
  const add = (path: string, category: WireDifference["category"], reason: string) => {
    differences.push({ path, category, reason });
  };
  const expectedSpans = scalarSpans(expected.bodyUtf8);
  const actualSpans = scalarSpans(actual.bodyUtf8);
  const maskedExpected: ScalarSpan[] = [];
  const maskedActual: ScalarSpan[] = [];
  const headers = new Set<number>();
  const seen = new Set<string>();
  for (const rule of dynamicRules) {
    if (
      !rule ||
      typeof rule.path !== "string" ||
      seen.has(rule.path) ||
      rule.path.includes("*") ||
      /~(?![01])/.test(rule.path) ||
      !["credential", "timestamp", "request-id", "session-id", "signature"].includes(rule.kind)
    )
      invalidRule();
    seen.add(rule.path);
    const header = /^\/headers\/(0|[1-9]\d*)\/1$/.exec(rule.path);
    let a: unknown;
    let b: unknown;
    if (header) {
      const index = Number(header[1]);
      if (!expected.headers[index] || !actual.headers[index]) invalidRule();
      headers.add(index);
      a = expected.headers[index][1];
      b = actual.headers[index][1];
    } else {
      if (rule.path !== "/body" && !rule.path.startsWith("/body/")) invalidRule();
      const left = expectedSpans.get(rule.path);
      const right = actualSpans.get(rule.path);
      if (left?.length !== 1 || right?.length !== 1) invalidRule();
      maskedExpected.push(left[0]);
      maskedActual.push(right[0]);
      a = left[0].value;
      b = right[0].value;
    }
    const leftShape = shape(a, rule.kind);
    const rightShape = shape(b, rule.kind);
    if (!leftShape || leftShape !== rightShape) {
      add(
        rule.path,
        header ? "header" : "body",
        "Dynamic scalar type or syntax differs or is invalid"
      );
    }
  }
  for (const key of ["method", "url", "httpVersion"] as const) {
    if (expected[key] !== actual[key]) add(`/${key}`, "http", "HTTP metadata differs");
  }
  if (expected.headers.length !== actual.headers.length)
    add("/headers", "header", "Header occurrence count differs");
  for (let index = 0; index < Math.min(expected.headers.length, actual.headers.length); index++) {
    if (expected.headers[index][0] !== actual.headers[index][0])
      add(`/headers/${index}/0`, "header", "Header name or occurrence order differs");
    if (!headers.has(index) && expected.headers[index][1] !== actual.headers[index][1])
      add(`/headers/${index}/1`, "header", "Header value differs");
  }
  function mask(body: string, spans: ScalarSpan[]): string {
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      // NUL cannot occur literally inside valid JSON, avoiding sentinel collisions.
      body = body.slice(0, span.start) + "\0" + body.slice(span.end);
    }
    return body;
  }
  if (mask(expected.bodyUtf8, maskedExpected) !== mask(actual.bodyUtf8, maskedActual)) {
    add("/bodyUtf8", "body", "Serialized body bytes differ outside dynamic scalar tokens");
  }
  return differences;
}
