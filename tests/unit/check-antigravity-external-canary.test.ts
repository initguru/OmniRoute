import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  parseAntigravityCanaryApproval,
  verifyApprovedAntigravityBinary,
  runAntigravityExternalCanary,
  CANARY_EXIT_CODES,
  type AntigravityCanaryApproval,
} from "../../scripts/check/antigravityCanaryCore.ts";

test("parseAntigravityCanaryApproval accepts valid approval and rejects invalid schemas", () => {
  const valid = {
    schemaVersion: 1,
    approvedAt: "2026-09-10T00:00:00.000Z",
    profiles: {
      ide: {
        binaryPath: "/path/to/language_server",
        expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        signer: {
          kind: "codesign",
          id: "EQHXZ8M8AV", // Google Team ID
          verified: true,
        },
        expectedVersion: "2.0.6",
        platform: "darwin-arm64",
      },
    },
  };

  const parsed = parseAntigravityCanaryApproval(valid);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.profiles.ide?.expectedVersion, "2.0.6");

  assert.throws(() => parseAntigravityCanaryApproval(null), /schema/i);
  assert.throws(() => parseAntigravityCanaryApproval({}), /schema/i);
  assert.throws(() => parseAntigravityCanaryApproval({ schemaVersion: 0 }), /schema/i);
  assert.throws(
    () =>
      parseAntigravityCanaryApproval({
        ...valid,
        profiles: { ide: { ...valid.profiles.ide, expectedSha256: "short" } },
      }),
    /sha256/i
  );
});

test("verifyApprovedAntigravityBinary validates sha256 streaming hash and codesign", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
  try {
    const dummyBinary = path.join(tmpDir, "dummy");
    fs.writeFileSync(dummyBinary, "binary-content-1234");

    // SHA256 mismatch
    await assert.rejects(async () => {
      await verifyApprovedAntigravityBinary(dummyBinary, {
        binaryPath: dummyBinary,
        expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
        signer: { kind: "codesign", id: "TEST", verified: true },
        expectedVersion: "1.0.0",
        platform: "darwin",
      });
    }, /sha256 mismatch/i);

    // SHA256 match, but codesign verification with custom/mock codesign checker or testing node executable
    if (process.platform === "darwin") {
      const nodePath = process.execPath;
      const nodeSha256 = createHash("sha256").update(fs.readFileSync(nodePath)).digest("hex");

      // Verify with matching sha256 but wrong signer id
      await assert.rejects(async () => {
        await verifyApprovedAntigravityBinary(nodePath, {
          binaryPath: nodePath,
          expectedSha256: nodeSha256,
          signer: { kind: "codesign", id: "WRONG_SIGNER_ID", verified: true },
          expectedVersion: "1.0.0",
          platform: "darwin",
        });
      }, /signer/i);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runAntigravityExternalCanary returns blocked (20) for CLI profile due to capture_adapter_unavailable", async () => {
  const approval: AntigravityCanaryApproval = {
    schemaVersion: 1,
    approvedAt: "2026-09-10T00:00:00.000Z",
    profiles: {
      cli: {
        binaryPath: "/path/to/cli",
        expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        signer: { kind: "codesign", id: "TEST", verified: true },
        expectedVersion: "1.0.0",
        platform: "darwin",
      },
    },
  };

  const result = await runAntigravityExternalCanary({
    profile: "cli",
    approval,
  });

  assert.equal(result.exitCode, CANARY_EXIT_CODES.BLOCKED);
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "capture_adapter_unavailable");
});

test("runAntigravityExternalCanary returns blocked (20) when approval is missing or unverified", async () => {
  const result = await runAntigravityExternalCanary({
    profile: "ide",
    approval: null,
  });

  assert.equal(result.exitCode, CANARY_EXIT_CODES.BLOCKED);
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "approval_missing");
});

test("runAntigravityExternalCanary returns pass (0) when observed wire requests match baseline manifest", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-pass-"));
  const dummyBinary = path.join(tmpDir, "dummy_ls");
  fs.writeFileSync(dummyBinary, "binary-content-verified");
  const dummySha256 = createHash("sha256").update("binary-content-verified").digest("hex");

  const approval: AntigravityCanaryApproval = {
    schemaVersion: 1,
    approvedAt: "2026-09-10T00:00:00.000Z",
    profiles: {
      ide: {
        binaryPath: dummyBinary,
        expectedSha256: dummySha256,
        signer: { kind: "codesign", id: "MOCK_SIGNER", verified: true },
        expectedVersion: "2.0.6",
        platform: "darwin-arm64",
      },
    },
  };

  const outputPath = path.join(tmpDir, "result-artifact.json");

  // Mock observation runner matching tests/fixtures/antigravity-wire/ide-manifest.json
  const mockObservationRunner = async () => [
    {
      method: "POST",
      url: "http://127.0.0.1:1234/v1internal:generateContent",
      httpVersion: "1.1",
      headers: [
        ["content-type", "application/json"],
        ["user-agent", "antigravity/2.0.6"],
        ["authorization", "[redacted]"],
      ],
      bodyUtf8: JSON.stringify({
        project: "synthetic-project",
        model: "claude-sonnet-4-5",
        request: {
          contents: ["ACK"],
        },
      }),
    },
  ];

  try {
    const result = await runAntigravityExternalCanary({
      profile: "ide",
      approval,
      outputPath,
      runObservation: mockObservationRunner,
      codesignVerifier: async () => true, // Mock codesign verifier passing
    });

    assert.equal(result.exitCode, CANARY_EXIT_CODES.PASS);
    assert.equal(result.status, "pass");
    assert.equal(result.reasonCode, "verified");
    assert.ok(fs.existsSync(outputPath));

    // Verify written artifact is redacted
    const artifact = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(artifact.provenance.profile, "ide");
    assert.ok(Array.isArray(artifact.observations));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runAntigravityExternalCanary returns drift (10) when observed wire requests deviate from baseline manifest", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-drift-"));
  const dummyBinary = path.join(tmpDir, "dummy_ls");
  fs.writeFileSync(dummyBinary, "binary-content-verified");
  const dummySha256 = createHash("sha256").update("binary-content-verified").digest("hex");

  const approval: AntigravityCanaryApproval = {
    schemaVersion: 1,
    approvedAt: "2026-09-10T00:00:00.000Z",
    profiles: {
      ide: {
        binaryPath: dummyBinary,
        expectedSha256: dummySha256,
        signer: { kind: "codesign", id: "MOCK_SIGNER", verified: true },
        expectedVersion: "2.0.6",
        platform: "darwin-arm64",
      },
    },
  };

  // Mock observation runner returning DIFFERENT path and shape
  const mockDriftingRunner = async () => [
    {
      method: "POST",
      url: "http://127.0.0.1:1234/v2internal:differentContent",
      httpVersion: "1.1",
      headers: [["content-type", "application/json"]],
      bodyUtf8: JSON.stringify({
        unexpectedKey: "drifted",
      }),
    },
  ];

  try {
    const result = await runAntigravityExternalCanary({
      profile: "ide",
      approval,
      runObservation: mockDriftingRunner,
      codesignVerifier: async () => true,
    });

    assert.equal(result.exitCode, CANARY_EXIT_CODES.DRIFT);
    assert.equal(result.status, "drift");
    assert.equal(result.reasonCode, "wire_drift_detected");
    assert.ok(result.differences && result.differences.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
