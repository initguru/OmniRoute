import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-system-prompt-cas-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";
if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = "test-system-prompt-cas-" + Date.now();
}

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const systemPromptRoute = await import("../../../src/app/api/settings/system-prompt/route.ts");
const { getSystemPromptConfig, setSystemPromptConfig } =
  await import("@omniroute/open-sse/services/systemPrompt.ts");

beforeEach(() => {
  core.resetDbInstance();
  setSystemPromptConfig({ enabled: false, prefixPrompt: "", suffixPrompt: "" });
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("system prompt route concurrency and CAS", () => {
  test("GET /api/settings/system-prompt returns atomic snapshot with settingsRevision and ETag", async () => {
    const req = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "GET",
    });
    const res = await systemPromptRoute.GET(req);
    assert.equal(res.status, 200);

    const etag = res.headers.get("ETag");
    const cacheControl = res.headers.get("Cache-Control");
    assert.equal(cacheControl, "no-store");
    assert.equal(etag, "0");

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.settingsRevision, 0);
    assert.equal(
      "revision" in body,
      false,
      "Public response body must not contain 'revision' alias"
    );
    assert.equal(typeof body.enabled, "boolean");
    assert.equal(typeof body.prefixPrompt, "string");
    assert.equal(typeof body.suffixPrompt, "string");
  });

  test("PUT without If-Match or expectedRevision returns 428 PRECONDITION_REQUIRED", async () => {
    const req = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        prefixPrompt: "Prefix without revision",
        suffixPrompt: "Suffix without revision",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await systemPromptRoute.PUT(req);
    assert.equal(res.status, 428);

    const body = (await res.json()) as Record<string, unknown>;
    const errorObj = body.error as Record<string, unknown>;
    assert.equal(errorObj.code, "PRECONDITION_REQUIRED");

    const snapshot = await settingsDb.getSystemPromptSettingSnapshot();
    assert.equal(snapshot.settingsRevision, 0);
    assert.equal(snapshot.config.enabled, false);
  });

  test("PUT with malformed revision or header/body mismatch returns 400 INVALID_EXPECTED_REVISION", async () => {
    // Malformed header
    const reqHeader = await makeManagementSessionRequest(
      "http://localhost/api/settings/system-prompt",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          prefixPrompt: "P",
          suffixPrompt: "S",
          expectedRevision: 0,
        }),
        headers: { "Content-Type": "application/json", "If-Match": '"invalid"' },
      }
    );
    const resHeader = await systemPromptRoute.PUT(reqHeader);
    assert.equal(resHeader.status, 400);
    const bodyHeader = (await resHeader.json()) as Record<string, unknown>;
    assert.equal((bodyHeader.error as Record<string, unknown>).code, "INVALID_EXPECTED_REVISION");

    // Mismatch
    const reqMismatch = await makeManagementSessionRequest(
      "http://localhost/api/settings/system-prompt",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          prefixPrompt: "P",
          suffixPrompt: "S",
          expectedRevision: 5,
        }),
        headers: { "Content-Type": "application/json", "If-Match": '"0"' },
      }
    );
    const resMismatch = await systemPromptRoute.PUT(reqMismatch);
    assert.equal(resMismatch.status, 400);
    const bodyMismatch = (await resMismatch.json()) as Record<string, unknown>;
    assert.equal((bodyMismatch.error as Record<string, unknown>).code, "INVALID_EXPECTED_REVISION");
  });

  test("PUT requires full canonical payload: missing enabled, prefixPrompt, or suffixPrompt returns 400", async () => {
    const req = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        prefixPrompt: "Only prefix",
        expectedRevision: 0,
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await systemPromptRoute.PUT(req);
    assert.equal(res.status, 400);
  });

  test("PUT with legacy 'prompt' field fails validation with 400 (strict full canonical payload)", async () => {
    const req = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        prefixPrompt: "Prefix",
        suffixPrompt: "Suffix",
        prompt: "Legacy field not allowed",
        expectedRevision: 0,
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await systemPromptRoute.PUT(req);
    assert.equal(res.status, 400);
  });

  test("PUT with stale revision returns 409 SETTINGS_REVISION_CONFLICT, ETag, and currentRevision", async () => {
    const req = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        prefixPrompt: "Prefix",
        suffixPrompt: "Suffix",
        expectedRevision: 99,
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await systemPromptRoute.PUT(req);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("ETag"), "0");

    const body = (await res.json()) as Record<string, unknown>;
    const errorObj = body.error as Record<string, unknown>;
    assert.equal(errorObj.code, "SETTINGS_REVISION_CONFLICT");
    assert.equal(errorObj.currentRevision, 0);
  });

  test("Concurrent writers A and B: A succeeds (N->N+1), B fails with 409 on revision N", async () => {
    // Writer A
    const reqA = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        prefixPrompt: "Writer A",
        suffixPrompt: "",
        expectedRevision: 0,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const resA = await systemPromptRoute.PUT(reqA);
    assert.equal(resA.status, 200);
    const bodyA = (await resA.json()) as Record<string, unknown>;
    assert.equal(bodyA.settingsRevision, 1);
    assert.equal(resA.headers.get("ETag"), "1");

    // Writer B with stale revision 0
    const reqB = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        prefixPrompt: "Writer B",
        suffixPrompt: "",
        expectedRevision: 0,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const resB = await systemPromptRoute.PUT(reqB);
    assert.equal(resB.status, 409);
    assert.equal(resB.headers.get("ETag"), "1");
    const bodyB = (await resB.json()) as Record<string, unknown>;
    assert.equal((bodyB.error as Record<string, unknown>).currentRevision, 1);
  });

  test("Pre-write mutation eliminated: runtime getSystemPromptConfig() and DB invariant on 400/409/428 rejection", async () => {
    // Establish clean baseline
    const baselineReq = await makeManagementSessionRequest(
      "http://localhost/api/settings/system-prompt",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          prefixPrompt: "Baseline Prefix",
          suffixPrompt: "Baseline Suffix",
          expectedRevision: 0,
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const baselineRes = await systemPromptRoute.PUT(baselineReq);
    assert.equal(baselineRes.status, 200);

    const baselineRuntime = getSystemPromptConfig();
    assert.equal(baselineRuntime.prefixPrompt, "Baseline Prefix");
    assert.equal(baselineRuntime.enabled, true);

    // Attempt 1: 428 rejection
    const bad428 = await makeManagementSessionRequest(
      "http://localhost/api/settings/system-prompt",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: false,
          prefixPrompt: "MUTATION ATTEMPT 428",
          suffixPrompt: "MUTATION ATTEMPT 428",
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const res428 = await systemPromptRoute.PUT(bad428);
    assert.equal(res428.status, 428);
    assert.equal(
      getSystemPromptConfig().prefixPrompt,
      "Baseline Prefix",
      "Runtime mutated on 428!"
    );

    // Attempt 2: 400 validation rejection
    const bad400 = await makeManagementSessionRequest(
      "http://localhost/api/settings/system-prompt",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: false,
          prefixPrompt: "MUTATION ATTEMPT 400",
          prompt: "legacy invalid",
          expectedRevision: 1,
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const res400 = await systemPromptRoute.PUT(bad400);
    assert.equal(res400.status, 400);
    assert.equal(
      getSystemPromptConfig().prefixPrompt,
      "Baseline Prefix",
      "Runtime mutated on 400!"
    );

    // Attempt 3: 409 conflict rejection
    const bad409 = await makeManagementSessionRequest(
      "http://localhost/api/settings/system-prompt",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: false,
          prefixPrompt: "MUTATION ATTEMPT 409",
          suffixPrompt: "MUTATION ATTEMPT 409",
          expectedRevision: 0, // stale
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const res409 = await systemPromptRoute.PUT(bad409);
    assert.equal(res409.status, 409);
    assert.equal(
      getSystemPromptConfig().prefixPrompt,
      "Baseline Prefix",
      "Runtime mutated on 409!"
    );

    // Verify DB state completely unchanged
    const snapshot = await settingsDb.getSystemPromptSettingSnapshot();
    assert.equal(snapshot.settingsRevision, 1);
    assert.equal(snapshot.config.prefixPrompt, "Baseline Prefix");
    assert.equal(snapshot.config.enabled, true);
  });

  test("Successful PUT: strips expectedRevision from stored DB payload, increments revision, applies to runtime post-commit", async () => {
    const req = await makeManagementSessionRequest("http://localhost/api/settings/system-prompt", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        prefixPrompt: "Clean Prefix",
        suffixPrompt: "Clean Suffix",
        expectedRevision: 0,
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await systemPromptRoute.PUT(req);
    assert.equal(res.status, 200);

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.settingsRevision, 1);
    assert.equal("expectedRevision" in body, false);

    // Verify DB row
    const db = core.getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = 'systemPrompt'")
      .get() as { value: string };
    const storedJson = JSON.parse(row.value) as Record<string, unknown>;
    assert.equal(
      "expectedRevision" in storedJson,
      false,
      "expectedRevision must be stripped from DB storage"
    );
    assert.equal(storedJson.prefixPrompt, "Clean Prefix");
    assert.equal(storedJson.suffixPrompt, "Clean Suffix");
    assert.equal(storedJson.enabled, true);

    // Verify runtime
    const runtime = getSystemPromptConfig();
    assert.equal(runtime.prefixPrompt, "Clean Prefix");
    assert.equal(runtime.suffixPrompt, "Clean Suffix");
    assert.equal(runtime.enabled, true);
  });
});
