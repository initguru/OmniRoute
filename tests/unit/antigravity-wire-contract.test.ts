import assert from "node:assert/strict";
import test from "node:test";
import {
  compareObservedRequests,
  type DynamicRule,
  type ObservedRequest,
} from "../helpers/antigravityWireContract.ts";

// Synthetic comparator inputs, not an official Antigravity contract.
const request = (bodyUtf8 = '{"items":[1,2],"id":"req-123"}'): ObservedRequest => ({
  method: "POST",
  url: "https://example.invalid/contract-test",
  httpVersion: "1.1",
  headers: [
    ["Content-Type", "application/json"],
    ["X-Test", "one"],
    ["X-Test", "two"],
  ],
  bodyUtf8,
});

test("identical requests match", () => {
  assert.deepEqual(compareObservedRequests(request(), request(), []), []);
});
for (const [name, body] of Object.entries({
  extra: '{"items":[1,2],"id":"req-123","extra":true}',
  omitted: '{"items":[1,2]}',
  null: '{"items":[1,2],"id":null}',
  type: '{"items":["1",2],"id":"req-123"}',
  arrayOrder: '{"items":[2,1],"id":"req-123"}',
  fieldOrder: '{"id":"req-123","items":[1,2]}',
  whitespace: '{ "items":[1,2],"id":"req-123"}',
  numberSpelling: '{"items":[1.0,2],"id":"req-123"}',
  duplicateKey: '{"items":[1,2],"id":"wrong","id":"req-123"}',
  escaped: '{"items":[1,2],"id":"req-12\\u0033"}',
})) {
  test(`detects body ${name}`, () => {
    assert.ok(
      compareObservedRequests(request(), request(body), []).some((d) => d.category === "body")
    );
  });
}
for (const field of ["method", "url", "httpVersion"] as const) {
  test(`detects ${field}`, () => {
    assert.ok(
      compareObservedRequests(request(), { ...request(), [field]: "different" }, []).length
    );
  });
}
for (const [name, headers] of Object.entries({
  order: [
    ["X-Test", "one"],
    ["Content-Type", "application/json"],
    ["X-Test", "two"],
  ],
  duplicate: [
    ["Content-Type", "application/json"],
    ["X-Test", "one"],
  ],
  case: [
    ["content-type", "application/json"],
    ["X-Test", "one"],
    ["X-Test", "two"],
  ],
  value: [
    ["Content-Type", "application/json"],
    ["X-Test", "one"],
    ["X-Test", "changed"],
  ],
})) {
  test(`detects header ${name}`, () => {
    assert.ok(
      compareObservedRequests(
        request(),
        { ...request(), headers: headers as Array<[string, string]> },
        []
      ).some((d) => d.category === "header")
    );
  });
}
const idRule: DynamicRule[] = [{ path: "/body/id", kind: "request-id" }];
test("dynamic request IDs accept agent IDs and UUIDs without masking their format", () => {
  for (const [left, right] of [
    ["agent/1788760000000/ab12cd34", "agent/1788760001000/1234abcd"],
    ["d9dabbf5-4275-4137-b8e0-397cb2fbe6f8", "a1b2c3d4-5555-4444-aaaa-123456789abc"],
  ]) {
    const expected = request(JSON.stringify({ id: left }));
    assert.deepEqual(
      compareObservedRequests(expected, request(JSON.stringify({ id: right })), idRule),
      []
    );
    assert.ok(
      compareObservedRequests(expected, request('{"id":"different-id-format"}'), idRule).length
    );
  }
});
test("dynamic scalar permits matching syntax while preserving surrounding bytes", () => {
  assert.deepEqual(
    compareObservedRequests(request(), request('{"items":[1,2],"id":"req-4567"}'), idRule),
    []
  );
  assert.ok(
    compareObservedRequests(request(), request('{ "items":[1,2],"id":"req-4567"}'), idRule).length
  );
  assert.ok(
    compareObservedRequests(request(), request('{"items":[2,1],"id":"req-4567"}'), idRule).length
  );
});
test("dynamic scalar rejects incompatible type and shape", () => {
  for (const value of [null, 123, "", "spaces here", "abc"]) {
    assert.ok(
      compareObservedRequests(
        request(),
        request(JSON.stringify({ items: [1, 2], id: value })),
        idRule
      ).length
    );
  }
});
test("rules reject malformed, unresolved, overlapping and duplicate paths", () => {
  for (const path of [
    "",
    "body.id",
    "/body/*",
    "/body/missing",
    "/body/id/x",
    "/headers/01/1",
    "/headers/0/0",
    "/body/~2",
  ]) {
    assert.throws(
      () => compareObservedRequests(request(), request(), [{ path, kind: "credential" }]),
      /dynamic rule/i
    );
  }
  assert.throws(
    () => compareObservedRequests(request(), request(), [...idRule, ...idRule]),
    /dynamic rule/i
  );
  assert.throws(
    () => compareObservedRequests(request(), request('{"items":[1,2]}'), idRule),
    /dynamic rule/i
  );
  assert.throws(
    () =>
      compareObservedRequests(request(), request(), [{ path: "/body/items", kind: "credential" }]),
    /dynamic rule/i
  );
});
test("JSON Pointer escaping and array indexes resolve exactly", () => {
  const rules: DynamicRule[] = [{ path: "/body/a~1b/~0/0", kind: "session-id" }];
  assert.deepEqual(
    compareObservedRequests(
      request('{"a/b":{"~":["s-1"]}}'),
      request('{"a/b":{"~":["s-2"]}}'),
      rules
    ),
    []
  );
});
test("dynamic header occurrence permits token changes but preserves names and scheme", () => {
  const a = request();
  a.headers.push(["Authorization", "Bearer abc123"]);
  const b = structuredClone(a);
  b.headers[3][1] = "Bearer xyz456";
  const rules: DynamicRule[] = [{ path: "/headers/3/1", kind: "credential" }];
  assert.deepEqual(compareObservedRequests(a, b, rules), []);
  b.headers[3][1] = "Basic xyz456";
  assert.ok(compareObservedRequests(a, b, rules).length);
});
test("timestamps and signatures have syntax checks, not lifecycle claims", () => {
  for (const [kind, a, b] of [
    ["timestamp", 1700000000, 1800000000],
    ["timestamp", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    ["signature", "YWJjZA==", "ZWZnaA=="],
  ] as const) {
    const rules: DynamicRule[] = [{ path: "/body/value", kind }];
    assert.deepEqual(
      compareObservedRequests(
        request(JSON.stringify({ value: a })),
        request(JSON.stringify({ value: b })),
        rules
      ),
      []
    );
    assert.ok(
      compareObservedRequests(
        request(JSON.stringify({ value: a })),
        request('{"value":"bad value"}'),
        rules
      ).length
    );
  }
});
test("opaque bodies compare bytes and cannot resolve JSON rules", () => {
  assert.deepEqual(compareObservedRequests(request("raw"), request("raw"), []), []);
  assert.ok(compareObservedRequests(request("raw"), request("raw "), []).length);
  assert.throws(
    () => compareObservedRequests(request("raw"), request("raw"), idRule),
    /dynamic rule/i
  );
});
test("diagnostics do not reveal body or header values", () => {
  const a = request('{"secret":"PRIVATE_A"}');
  const b = request('{"secret":"PRIVATE_B"}');
  a.headers.push(["Authorization", "PRIVATE_C"]);
  b.headers.push(["Authorization", "PRIVATE_D"]);
  const differences = compareObservedRequests(a, b, []);
  assert.ok(differences.length);
  assert.ok(!JSON.stringify(differences).includes("PRIVATE_"));
});

test("dynamic rules cannot mask containers or ambiguous duplicate-key subtrees", () => {
  for (const body of [
    '{"items":[1,2],"id":{}}',
    '{"items":[1,2],"id":[]}',
    '{"items":[1,2],"id":"req-1","id":"req-2"}',
  ]) {
    assert.throws(() => compareObservedRequests(request(), request(body), idRule), /dynamic rule/i);
  }
  const rules: DynamicRule[] = [{ path: "/body/parent/id", kind: "request-id" }];
  const duplicate = request('{"parent":{"id":"req-1"},"parent":{"other":1}}');
  assert.throws(() => compareObservedRequests(duplicate, duplicate, rules), /dynamic rule/i);
});
test("multiple substitutions preserve every unrelated byte", () => {
  const rules: DynamicRule[] = [
    { path: "/body/id", kind: "request-id" },
    { path: "/body/time", kind: "timestamp" },
  ];
  const a = request('{"id":"r-1","time":123,"fixed":true}');
  const b = request('{"id":"r-222","time":4567,"fixed":true}');
  assert.deepEqual(compareObservedRequests(a, b, rules), []);
  assert.ok(
    compareObservedRequests(a, request('{"id":"r-222", "time":4567,"fixed":true}'), rules).length
  );
});
test("header masking does not hide occurrence names and rules require both occurrences", () => {
  const rules: DynamicRule[] = [{ path: "/headers/1/1", kind: "credential" }];
  const a = request();
  const b = request();
  b.headers[1] = ["X-Other", "one"];
  assert.ok(compareObservedRequests(a, b, rules).some((d) => d.path === "/headers/1/0"));
  b.headers = [];
  assert.throws(() => compareObservedRequests(a, b, rules), /dynamic rule/i);
});
test("scalar root dynamic path resolves and unsupported kinds reject", () => {
  assert.deepEqual(
    compareObservedRequests(request('"s-1"'), request('"s-2"'), [
      { path: "/body", kind: "session-id" },
    ]),
    []
  );
  assert.throws(
    () =>
      compareObservedRequests(request(), request(), [
        { path: "/body/id", kind: "unknown" } as unknown as DynamicRule,
      ]),
    /dynamic rule/i
  );
});
