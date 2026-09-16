import test from "node:test";
import assert from "node:assert/strict";
import { setupSettingsFixture } from "../_mocks/settings.ts";
import * as core from "../../../src/lib/db/core.ts";
import * as settingsDb from "../../../src/lib/db/settings.ts";
import {
  settingsResponseHeaders,
  parseOptInExpectedRevision,
  parseMandatoryExpectedRevision,
} from "../../../src/lib/api/settingsRevision.ts";

const fixture = setupSettingsFixture("settings-revision-helper");

test.after(() => {
  core.resetDbInstance();
  fixture.cleanup();
});

test("settingsResponseHeaders produces Cache-Control no-store and string ETag", () => {
  const headers = settingsResponseHeaders(42);
  assert.deepEqual(headers, {
    "Cache-Control": "no-store",
    ETag: "42",
  });
});

test("parseMandatoryExpectedRevision: missing header and missing body -> 428 PRECONDITION_REQUIRED", () => {
  const req = new Request("http://localhost/api/settings/system-prompt", { method: "PUT" });
  const result = parseMandatoryExpectedRevision(req, {
    enabled: true,
    prefixPrompt: "p",
    suffixPrompt: "s",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.status, 428);
    assert.equal(result.error.code, "PRECONDITION_REQUIRED");
  }
});

test("parseMandatoryExpectedRevision: malformed header returns 400 even if body has valid integer", () => {
  const malformedHeaders = ['"abc"', '"-1"', '"1.5"', "abc", "W/"];
  for (const headerVal of malformedHeaders) {
    const req = new Request("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      headers: { "If-Match": headerVal },
    });
    const result = parseMandatoryExpectedRevision(req, { expectedRevision: 10 });
    assert.equal(result.success, false, `Expected failure for header ${headerVal}`);
    if (!result.success) {
      assert.equal(result.error.status, 400);
      assert.equal(result.error.code, "INVALID_EXPECTED_REVISION");
    }
  }
});

test("parseMandatoryExpectedRevision: malformed body returns 400", () => {
  const malformedBodies: Array<Record<string, unknown>> = [
    { expectedRevision: -1 },
    { expectedRevision: "10" },
    { expectedRevision: 1.5 },
    { expectedRevision: NaN },
    { expectedRevision: Infinity },
  ];
  for (const body of malformedBodies) {
    const req = new Request("http://localhost/api/settings/system-prompt", { method: "PUT" });
    const result = parseMandatoryExpectedRevision(req, body);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.status, 400);
      assert.equal(result.error.code, "INVALID_EXPECTED_REVISION");
    }
  }
});

test("parseMandatoryExpectedRevision: valid header and valid body with mismatch returns 400", () => {
  const req = new Request("http://localhost/api/settings/system-prompt", {
    method: "PUT",
    headers: { "If-Match": '"10"' },
  });
  const result = parseMandatoryExpectedRevision(req, { expectedRevision: 11 });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.status, 400);
    assert.equal(result.error.code, "INVALID_EXPECTED_REVISION");
  }
});

test("parseMandatoryExpectedRevision: valid header only returns success", () => {
  const validHeaders = ['"14"', 'W/"14"', "14"];
  for (const h of validHeaders) {
    const req = new Request("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      headers: { "If-Match": h },
    });
    const result = parseMandatoryExpectedRevision(req);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.expectedRevision, 14);
    }
  }
});

test("parseMandatoryExpectedRevision: valid body only returns success", () => {
  const req = new Request("http://localhost/api/settings/system-prompt", { method: "PUT" });
  const result = parseMandatoryExpectedRevision(req, { expectedRevision: 14 });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.expectedRevision, 14);
  }
});

test("parseMandatoryExpectedRevision: valid matching header and body returns success", () => {
  const req = new Request("http://localhost/api/settings/system-prompt", {
    method: "PUT",
    headers: { "If-Match": '"14"' },
  });
  const result = parseMandatoryExpectedRevision(req, { expectedRevision: 14 });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.expectedRevision, 14);
  }
});

test("parseOptInExpectedRevision: preserves opt-in behavior", () => {
  const emptyReq = new Request("http://localhost/api/settings", { method: "PATCH" });
  assert.equal(parseOptInExpectedRevision(emptyReq, {}), undefined);

  const headerReq = new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "If-Match": '"20"' },
  });
  assert.equal(parseOptInExpectedRevision(headerReq, {}), 20);

  const weakHeaderReq = new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "If-Match": 'W/"20"' },
  });
  assert.equal(parseOptInExpectedRevision(weakHeaderReq, {}), 20);

  const bodyReq = new Request("http://localhost/api/settings", { method: "PATCH" });
  assert.equal(parseOptInExpectedRevision(bodyReq, { expectedRevision: 25 }), 25);

  const invalidHeaderReq = new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "If-Match": "invalid" },
  });
  assert.equal(parseOptInExpectedRevision(invalidHeaderReq, { expectedRevision: 30 }), 30);
});

test("getSystemPromptSettingSnapshot: reads snapshot atomically with defaults and legacy prompt fallback", async () => {
  await fixture.resetStorage();
  const db = core.getDbInstance();

  // Fresh DB defaults
  const initialSnapshot = await settingsDb.getSystemPromptSettingSnapshot();
  assert.deepEqual(initialSnapshot.config, {
    enabled: false,
    prefixPrompt: "",
    suffixPrompt: "",
  });
  assert.equal(initialSnapshot.settingsRevision, 0);

  // Set legacy prompt row
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'systemPrompt', ?)"
  ).run(JSON.stringify({ enabled: true, prompt: "Legacy system prompt text" }));
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', '_settingsRevision', ?)"
  ).run(JSON.stringify(7));

  const legacySnapshot = await settingsDb.getSystemPromptSettingSnapshot();
  assert.equal(legacySnapshot.settingsRevision, 7);
  assert.equal(legacySnapshot.config.enabled, true);
  assert.equal(legacySnapshot.config.prefixPrompt, "");
  assert.equal(legacySnapshot.config.suffixPrompt, "Legacy system prompt text");

  // Modern prompt row with both prefix and suffix
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'systemPrompt', ?)"
  ).run(
    JSON.stringify({
      enabled: true,
      prefixPrompt: "Prefix text",
      suffixPrompt: "Suffix text",
      prompt: "Legacy ignored because suffix exists",
    })
  );
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', '_settingsRevision', ?)"
  ).run(JSON.stringify(8));

  const modernSnapshot = await settingsDb.getSystemPromptSettingSnapshot();
  assert.equal(modernSnapshot.settingsRevision, 8);
  assert.equal(modernSnapshot.config.enabled, true);
  assert.equal(modernSnapshot.config.prefixPrompt, "Prefix text");
  assert.equal(modernSnapshot.config.suffixPrompt, "Suffix text");
});
