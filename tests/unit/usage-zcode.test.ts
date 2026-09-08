/**
 * tests/unit/usage-zcode.test.ts
 *
 * Unit tests for ZCode (Z.ai Coding Plan) usage fetcher, credential cipher,
 * quota normalization, and registry wiring.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { decryptZCodeCredential, getZCodeUsage } from "../../open-sse/services/usage/zcode.ts";
import { USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage/fetcherProviders.ts";
import { USAGE_SUPPORTED_PROVIDERS } from "../../open-sse/services/usage/supportedProviders.ts";
import {
  PROVIDER_LABEL,
  PROVIDER_ORDER,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/constants.ts";
import { formatQuotaLabel } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx";
import { isSupportedUsageConnection } from "../../src/lib/usage/providerLimits.ts";

function encryptWithFallbackSecret(plaintext: string, _env = process.env): string {
  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    // ignore
  }
  const rawSecret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  const key = createHash("sha256").update(rawSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

describe("ZCode Credential Cipher", () => {
  it("passes through plaintext credentials unchanged", () => {
    assert.equal(decryptZCodeCredential("plain-api-token"), "plain-api-token");
    assert.equal(decryptZCodeCredential("eyJhbGciOi..."), "eyJhbGciOi...");
  });

  it("returns invalid enc formats unchanged if not 3 segments", () => {
    assert.equal(decryptZCodeCredential("enc:v1:invalid-data"), "enc:v1:invalid-data");
  });

  it("decrypts valid AES-256-GCM ciphertext encrypted with fallback key", () => {
    const originalToken = "zcode-desktop-jwt-token-sample-12345";
    const encrypted = encryptWithFallbackSecret(originalToken);
    assert.ok(encrypted.startsWith("enc:v1:"));

    const decrypted = decryptZCodeCredential(encrypted);
    assert.equal(decrypted, originalToken);
  });
});

type OsWithMutableHomedir = typeof os & { homedir: () => string };

describe("ZCode Usage Quota Parser & Fetcher", () => {
  it("returns error message when credentials file does not exist", async () => {
    // Temporarily mock HOME to a non-existent dir
    const mutableOs = os as unknown as OsWithMutableHomedir;
    const originalHome = os.homedir;
    try {
      mutableOs.homedir = () => "/tmp/non-existent-zcode-dir";
      const result = await getZCodeUsage();
      assert.ok("message" in result);
      assert.match(result.message, /ZCode Desktop credentials not found/);
    } finally {
      mutableOs.homedir = originalHome;
    }
  });

  it("normalizes live ZCode balance API responses to UsageQuota map", async () => {
    const mockBalanceResponse = {
      code: 0,
      msg: "success",
      data: {
        balances: [
          {
            entitlement_id: "glm-5.3",
            show_name: "GLM-5.3",
            total_units: 3000000,
            used_units: 29342,
            remaining_units: 2970658,
            expires_at: 1788883199,
          },
          {
            entitlement_id: "glm-5.3-flash",
            show_name: "GLM-5.3-Flash",
            total_units: 5000000,
            used_units: 143290,
            remaining_units: 4856710,
            expires_at: 1788883199,
          },
        ],
      },
    };

    const originalFetch = globalThis.fetch;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-test-"));
    const v2Dir = path.join(tempDir, ".zcode", "v2");
    fs.mkdirSync(v2Dir, { recursive: true });

    const credsFile = path.join(v2Dir, "credentials.json");
    fs.writeFileSync(credsFile, JSON.stringify({ zcodejwttoken: "mock-zcode-token" }), "utf8");

    const mutableOs = os as unknown as OsWithMutableHomedir;
    const originalHome = os.homedir;
    try {
      mutableOs.homedir = () => tempDir;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockBalanceResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const result = await getZCodeUsage();
      assert.ok(!("message" in result));

      assert.ok(result["glm-5.3"]);
      assert.equal(result["glm-5.3"].total, 3000000);
      assert.equal(result["glm-5.3"].used, 29342);
      assert.equal(result["glm-5.3"].remaining, 2970658);
      assert.equal(result["glm-5.3"].displayName, "GLM-5.3");
      assert.equal(result["glm-5.3"].remainingPercentage, 99);
      assert.ok(result["glm-5.3"].resetAt);

      assert.ok(result["glm-5.3-flash"]);
      assert.equal(result["glm-5.3-flash"].total, 5000000);
      assert.equal(result["glm-5.3-flash"].used, 143290);
      assert.equal(result["glm-5.3-flash"].remaining, 4856710);
      assert.equal(result["glm-5.3-flash"].displayName, "GLM-5.3-Flash");
      assert.equal(result["glm-5.3-flash"].remainingPercentage, 97.1);
      assert.ok(result["glm-5.3-flash"].resetAt);
    } finally {
      mutableOs.homedir = originalHome;
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles 401 unauthorized session expiration", async () => {
    const originalFetch = globalThis.fetch;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-test-"));
    const v2Dir = path.join(tempDir, ".zcode", "v2");
    fs.mkdirSync(v2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(v2Dir, "credentials.json"),
      JSON.stringify({ token: "expired-token" }),
      "utf8"
    );

    const mutableOs = os as unknown as OsWithMutableHomedir;
    const originalHome = os.homedir;
    try {
      mutableOs.homedir = () => tempDir;
      globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });

      const result = await getZCodeUsage();
      assert.ok("message" in result);
      assert.match(result.message, /ZCode session expired/);
    } finally {
      mutableOs.homedir = originalHome;
      globalThis.fetch = originalFetch;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("ZCode Provider Registry Wiring", () => {
  it("is registered in USAGE_FETCHER_PROVIDERS", () => {
    assert.ok(USAGE_FETCHER_PROVIDERS.includes("zcode"));
    assert.ok(USAGE_FETCHER_PROVIDERS.includes("zc"));
  });

  it("is registered in USAGE_SUPPORTED_PROVIDERS", () => {
    assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("zcode"));
    assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("zc"));
  });

  it("is configured with display label and order in dashboard constants", () => {
    assert.equal(PROVIDER_LABEL["zcode"], "ZCode");
    assert.equal(PROVIDER_LABEL["zc"], "ZCode");
    assert.equal(PROVIDER_ORDER["zcode"], 18);
    assert.equal(PROVIDER_ORDER["zc"], 18);
  });

  it("is recognized as a supported usage connection in providerLimits", () => {
    assert.equal(
      isSupportedUsageConnection({ provider: "zcode" } as Parameters<
        typeof isSupportedUsageConnection
      >[0]),
      true
    );
    assert.equal(
      isSupportedUsageConnection({ provider: "zc" } as Parameters<
        typeof isSupportedUsageConnection
      >[0]),
      true
    );
  });

  it("maps GLM model quotas to friendly labels in dashboard utils", () => {
    assert.equal(formatQuotaLabel("glm-5.3"), "GLM-5.3");
    assert.equal(formatQuotaLabel("glm-5.3-flash"), "GLM-5.3-Flash");
  });
});
