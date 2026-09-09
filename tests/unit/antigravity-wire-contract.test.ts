import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRedactedAntigravityArtifact,
  compareObservedRequests,
  createAntigravityStructuralDigest,
  type AntigravityObservedRequest,
  type AntigravityReferenceManifest,
  type AntigravityStructuralSummary,
} from "../helpers/antigravityWireContract.ts";

const request = (bodyUtf8 = '{"contents":[]}'): AntigravityObservedRequest => ({
  method: "POST",
  url: "https://example.invalid/contract-test?fixed=1",
  httpVersion: "1.1",
  headers: [
    ["Content-Type", "application/json"],
    ["X-Test", "one"],
  ],
  bodyUtf8,
});

test("identical synthetic requests match", () => {
  assert.deepEqual(compareObservedRequests(request(), request()), []);
});

test("does not normalize an unexpected envelope field away", () => {
  const expected = request('{"contents":[]}');
  const actual = request('{"contents":[],"unexpected":true}');
  assert.ok(compareObservedRequests(expected, actual, []).some((d) => d.category === "body"));
});

test("reports duplicate header occurrences", () => {
  const actual = request();
  actual.headers.push(["X-Test", "two"]);
  assert.ok(compareObservedRequests(request(), actual).some((d) => d.category === "header"));
});

test("reports header occurrence order changes", () => {
  const actual = request();
  actual.headers = [actual.headers[1], actual.headers[0]];
  assert.ok(compareObservedRequests(request(), actual).some((d) => d.category === "header"));
});

test("compares header names case-insensitively while preserving occurrences", () => {
  const actual = request();
  actual.headers[0][0] = "content-type";
  assert.deepEqual(compareObservedRequests(request(), actual), []);
});

test("reports body field missing versus explicit null", () => {
  const expected = request('{"contents":[],"project":null}');
  const actual = request('{"contents":[]}');
  assert.ok(compareObservedRequests(expected, actual).some((d) => d.category === "body"));
});

test("reports JSON array reordering", () => {
  const expected = request('{"contents":["first","second"]}');
  const actual = request('{"contents":["second","first"]}');
  assert.ok(compareObservedRequests(expected, actual).some((d) => d.category === "body"));
});

test("reports URL and query mismatches exactly", () => {
  const actual = { ...request(), url: "https://example.invalid/contract-test?fixed=2" };
  assert.ok(compareObservedRequests(request(), actual).some((d) => d.path === "/url"));
});

test("reports HTTP version mismatches", () => {
  const actual = { ...request(), httpVersion: "2.0" };
  assert.ok(compareObservedRequests(request(), actual).some((d) => d.path === "/httpVersion"));
});

test("reports an unknown dynamic path instead of ignoring it", () => {
  const differences = compareObservedRequests(request(), request(), [
    { path: "/body/notPresent", kind: "request-id", format: "opaque" },
  ]);
  assert.ok(differences.some((d) => d.category === "body"));
});

test("reports an invalid dynamic format instead of ignoring it", () => {
  const differences = compareObservedRequests(request(), request(), [
    {
      path: "/body/requestId",
      kind: "request-id",
      format: "not-a-format",
    } as never,
  ]);
  assert.ok(differences.some((d) => d.category === "body"));
});

test("validates a UUID dynamic value rather than treating it as an ignore path", () => {
  const expected = request('{"requestId":"not-a-uuid"}');
  const actual = request('{"requestId":"not-a-uuid"}');
  const differences = compareObservedRequests(expected, actual, [
    { path: "/body/requestId", kind: "request-id", format: "uuid" },
  ]);
  assert.ok(differences.some((d) => d.category === "body"));
});

test("permits two valid UUID values while preserving surrounding JSON bytes", () => {
  const expected = request('{"requestId":"d9dabbf5-4275-4137-b8e0-397cb2fbe6f8"}');
  const actual = request('{"requestId":"a1b2c3d4-5555-4444-aaaa-123456789abc"}');
  assert.deepEqual(
    compareObservedRequests(expected, actual, [
      { path: "/body/requestId", kind: "request-id", format: "uuid" },
    ]),
    []
  );
});

test("dynamic header rules require the declared header identity", () => {
  const expected = request();
  const actual = request();
  expected.headers.push(["Authorization", "Bearer expected"]);
  actual.headers.push(["Authorization", "Bearer actual"]);
  assert.deepEqual(
    compareObservedRequests(expected, actual, [
      {
        path: "/headers/2/1",
        kind: "credential",
        format: "opaque",
        headerName: "authorization",
        scheme: "Bearer",
      },
    ]),
    []
  );

  const contentType = request();
  contentType.headers[0][1] = "text/plain";
  const differences = compareObservedRequests(request(), contentType, [
    {
      path: "/headers/0/1",
      kind: "credential",
      format: "opaque",
      headerName: "content-type",
      scheme: "Bearer",
    },
  ] as never);
  assert.ok(differences.some((d) => d.category === "header"));
  assert.doesNotMatch(JSON.stringify(differences), /actual|expected|secret/i);
});

test("invalid dynamic paths are reported without throwing", () => {
  const cases = [
    [
      request(),
      { ...request(), headers: [] },
      [{ path: "/headers/9/1", kind: "credential", format: "opaque" }],
    ],
    [
      { ...request(), bodyUtf8: "raw" },
      { ...request(), bodyUtf8: "raw" },
      [{ path: "/body/id", kind: "request-id", format: "opaque" }],
    ],
    [request("{}"), request("{}"), [{ path: "/body", kind: "request-id", format: "opaque" }]],
    [
      request('{"id":{}}'),
      request('{"id":{}}'),
      [{ path: "/body/id", kind: "request-id", format: "opaque" }],
    ],
    [
      request('{"id":"one","id":"two"}'),
      request('{"id":"one","id":"three"}'),
      [{ path: "/body/id", kind: "request-id", format: "opaque" }],
    ],
  ] as const;
  for (const [expected, actual, rules] of cases) {
    assert.doesNotThrow(() => {
      const differences = compareObservedRequests(expected, actual, rules);
      assert.ok(differences.length > 0);
    });
  }
});

test("redaction guard accepts structural summaries and rejects sensitive raw values", () => {
  const summary: AntigravityStructuralSummary = {
    method: "POST",
    path: "/v1/content",
    bodyBytes: 42,
    bodyKeys: ["contents"],
    headerNames: ["content-type"],
  };
  const digest = createAntigravityStructuralDigest(summary);
  assert.match(digest, /^structural-sha256:[0-9a-f]{64}$/);
  assert.throws(
    () =>
      assertRedactedAntigravityArtifact({
        requestSummary: { ...summary, rawBody: "private" },
        structuralDigest: digest,
      }),
    /digest|summary/i
  );
  assert.doesNotThrow(() =>
    assertRedactedAntigravityArtifact({
      profile: "cli",
      source: "synthetic-only",
      requestSummary: summary,
      headers: [["Authorization", "[REDACTED]"]],
      structuralDigest: digest,
    })
  );
  assert.throws(
    () =>
      assertRedactedAntigravityArtifact({
        requestSummary: summary,
        structuralDigest: "sha256:" + "a".repeat(64),
      }),
    /digest/i
  );
  assert.throws(
    () =>
      assertRedactedAntigravityArtifact({
        requestSummary: summary,
        structuralDigest: digest.slice(0, -1) + "0",
      }),
    /digest/i
  );

  for (const value of [
    { authorization: "Bearer raw-access-token" },
    { AUTHORIZATION: "Bearer raw-access-token" },
    { refresh_token: "raw-refresh-token" },
    { API_KEY: "raw-api-key" },
    { APIKey: "raw-api-key" },
    { "X-API-Key": "raw-api-key" },
    { headers: [["Cookie", "session=raw-cookie"]] },
    { body: { prompt: "private prompt" } },
    { projectSecret: "raw-project-secret" },
    { MACHINE_ID: "raw-machine-id" },
    { machineID: "raw-machine-id" },
    { SESSION_ID: "raw-session-id" },
    { sessionID: "raw-session-id" },
    { session: "raw-session" },
  ]) {
    assert.throws(() => assertRedactedAntigravityArtifact(value), /redact/i);
  }
});

test("CLI and IDE manifests remain separate synthetic-only profiles", () => {
  const fixtureDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/antigravity-wire"
  );
  const cli = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "cli-manifest.json"), "utf8")
  ) as AntigravityReferenceManifest;
  const ide = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, "ide-manifest.json"), "utf8")
  ) as AntigravityReferenceManifest;

  assert.equal(cli.profile, "cli");
  assert.equal(cli.product, "agy-cli");
  assert.equal(ide.profile, "ide");
  assert.equal(ide.product, "antigravity-ide");
  assert.equal(cli.source, "synthetic-only");
  assert.equal(ide.source, "synthetic-only");
  assert.notEqual(cli.contractId, ide.contractId);
  assert.doesNotThrow(() => assertRedactedAntigravityArtifact(cli));
  assert.doesNotThrow(() => assertRedactedAntigravityArtifact(ide));
});
