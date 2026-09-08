import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildZcodeDirectBody,
  buildZcodeDirectHeaders,
  classifyZcodeDirectError,
  resolveZcodeDeviceId,
  resolveZcodeDirectAuth,
} from "../../open-sse/services/zcodeDirectProtocol.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;

describe("ZCode direct protocol auth", () => {
  it("loads the Start Plan API key and base URL from the desktop config", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zcode-direct-protocol-"));
    try {
      const configPath = path.join(directory, "cli", "config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              baseUrl: "https://direct.example.test/api",
              options: { apiKey: "  zcode-key  " },
            },
          },
        })
      );

      assert.deepEqual(resolveZcodeDirectAuth({ configPath }), {
        apiKey: "zcode-key",
        baseURL: "https://direct.example.test/api",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts explicit auth options and returns null when credentials are unavailable", () => {
    assert.deepEqual(
      resolveZcodeDirectAuth({ apiKey: "explicit-key", baseURL: "https://z.example" }),
      { apiKey: "explicit-key", baseURL: "https://z.example" }
    );
    assert.equal(resolveZcodeDirectAuth({ configPath: "/missing/zcode-config.json" }), null);
    assert.equal(resolveZcodeDirectAuth({ apiKey: "   " }), null);
  });
});

describe("ZCode direct protocol device identity", () => {
  it("reads deviceMid from telemetry state under the ZCode home", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zcode-direct-protocol-"));
    const originalHome = os.homedir;
    try {
      const telemetryPath = path.join(directory, ".zcode", "v2", "telemetry-state.json");
      await mkdir(path.dirname(telemetryPath), { recursive: true });
      await writeFile(telemetryPath, JSON.stringify({ deviceMid: "device-mid-123" }));
      (os as typeof os & { homedir: () => string }).homedir = () => directory;
      assert.equal(resolveZcodeDeviceId(), "device-mid-123");
    } finally {
      (os as typeof os & { homedir: () => string }).homedir = originalHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a stable UUID fallback when telemetry state is absent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zcode-direct-protocol-"));
    const originalHome = os.homedir;
    try {
      (os as typeof os & { homedir: () => string }).homedir = () => directory;
      const first = resolveZcodeDeviceId();
      const second = resolveZcodeDeviceId();
      assert.match(first, UUID);
      assert.equal(first, second);
    } finally {
      (os as typeof os & { homedir: () => string }).homedir = originalHome;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ZCode direct protocol headers", () => {
  it("emits auth, captcha, attribution, session, and content headers", () => {
    const headers = buildZcodeDirectHeaders({
      apiKey: "zcode-key",
      verifyParam: "captcha-token",
    });

    assert.equal(headers.authorization, "Bearer zcode-key");
    assert.equal(headers["x-api-key"], "zcode-key");
    assert.equal(headers["x-aliyun-captcha-verify-param"], "captcha-token");
    assert.equal(headers["x-aliyun-captcha-verify-region"], "sgp");
    assert.match(headers["x-request-id"], UUID);
    assert.equal(headers["x-zcode-session-type"], "main");
    assert.match(headers["x-zcode-trace-id"], UUID);
    assert.match(headers["x-session-id"], COMPACT_UUID);
    assert.match(headers["x-query-id"], COMPACT_UUID);
    assert.equal(headers["user-agent"], "ZCode/3.11.2");
    assert.equal(headers["x-zcode-app-version"], "3.11.2");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["anthropic-version"], undefined);
  });

  it("preserves supplied IDs, captcha region, and Anthropic version", () => {
    const headers = buildZcodeDirectHeaders({
      apiKey: "key",
      verifyParam: "token",
      region: "us-west",
      requestId: "request-1",
      traceId: "trace-1",
      sessionId: "session-1",
      queryId: "query-1",
      isAnthropic: true,
    });
    assert.equal(headers["x-aliyun-captcha-verify-region"], "us-west");
    assert.equal(headers["x-request-id"], "request-1");
    assert.equal(headers["x-zcode-trace-id"], "trace-1");
    assert.equal(headers["x-session-id"], "session-1");
    assert.equal(headers["x-query-id"], "query-1");
    assert.equal(headers["anthropic-version"], "2023-06-01");
  });
});

describe("ZCode direct protocol bodies", () => {
  it("builds an OpenAI-compatible chat completion body", () => {
    assert.deepEqual(
      buildZcodeDirectBody({
        model: "GLM-5.3",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        temperature: 0.2,
      }),
      {
        model: "GLM-5.3",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        temperature: 0.2,
      }
    );
  });

  it("builds an Anthropic Messages body with serialized user metadata", () => {
    assert.deepEqual(
      buildZcodeDirectBody({
        model: "GLM-5.3",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 1024,
        deviceId: "device-mid-1",
        sessionId: "session-1",
        isAnthropic: true,
      }),
      {
        model: "GLM-5.3",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 1024,
        metadata: {
          user_id: JSON.stringify({
            device_id: "device-mid-1",
            account_uuid: "",
            session_id: "session-1",
          }),
        },
      }
    );
  });
});

describe("ZCode direct protocol errors", () => {
  it("classifies CAPTCHA_VERIFY_FAILED and UNUSUAL_ACTIVITY provider codes", () => {
    const captcha = classifyZcodeDirectError(400, { code: 3007, message: "captcha failed" });
    const unusual = classifyZcodeDirectError(403, {
      error: { code: 3012, message: "unusual activity" },
    });
    assert.deepEqual(captcha, {
      isCaptchaError: true,
      isUnusualActivity: false,
      isAuthError: false,
      message: "captcha failed",
      code: 3007,
    });
    assert.equal(unusual.isCaptchaError, false);
    assert.equal(unusual.isUnusualActivity, true);
    assert.equal(unusual.isAuthError, true);
    assert.equal(unusual.code, 3012);
  });

  it("marks standard authentication failures and retains a safe message", () => {
    const result = classifyZcodeDirectError(401, { error: { message: "invalid key" } });
    assert.equal(result.isCaptchaError, false);
    assert.equal(result.isUnusualActivity, false);
    assert.equal(result.isAuthError, true);
    assert.equal(result.message, "invalid key");
    assert.equal(result.code, undefined);
  });
});
