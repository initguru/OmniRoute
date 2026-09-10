import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import type { AntigravityProfileId } from "@/shared/constants/antigravityClientProfile";
import {
  assertRedactedAntigravityArtifact,
  compareObservedRequests,
  validateAntigravityCanonicalProbe,
  validateAntigravityReferenceManifest,
  type AntigravityCanonicalProbe,
  type AntigravityDynamicRule,
  type AntigravityObservedRequest,
  type AntigravityReferenceManifest,
  type AntigravityStructuralObservation,
  type WireDifference,
} from "../../tests/helpers/antigravityWireContract.ts";

const execFileAsync = promisify(execFile);

export const CANARY_EXIT_CODES = {
  PASS: 0,
  DRIFT: 10,
  BLOCKED: 20,
  ERROR: 30,
} as const;

export type CanaryExitCode = (typeof CANARY_EXIT_CODES)[keyof typeof CANARY_EXIT_CODES];

export type AntigravityCanaryProfileApproval = {
  binaryPath: string;
  expectedSha256: string;
  signer: {
    kind: string;
    id: string;
    verified: boolean;
  };
  expectedVersion?: string;
  platform?: string;
};

export type AntigravityCanaryApproval = {
  schemaVersion: number;
  approvedAt: string;
  profiles: Partial<Record<AntigravityProfileId, AntigravityCanaryProfileApproval>>;
};

export type CanaryRunOptions = {
  profile: AntigravityProfileId;
  approval?: AntigravityCanaryApproval | null;
  approvalPath?: string;
  canonicalProbePath?: string;
  referenceManifestPath?: string;
  outputPath?: string;
  tempDir?: string;
  // Pluggable observation runner for testing/mocking
  runObservation?: (
    profileApproval: AntigravityCanaryProfileApproval,
    probe: AntigravityCanonicalProbe,
    scratchDir: string
  ) => Promise<AntigravityObservedRequest[]>;
  codesignVerifier?: (binaryPath: string, expectedSignerId: string) => Promise<boolean>;
};

export type CanaryRunResult = {
  status: "pass" | "drift" | "blocked" | "error";
  exitCode: CanaryExitCode;
  profile: AntigravityProfileId;
  reasonCode: string;
  message: string;
  differences?: WireDifference[];
  artifact?: unknown;
};

export function parseAntigravityCanaryApproval(raw: unknown): AntigravityCanaryApproval {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Antigravity canary approval schema: root must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== "number" || obj.schemaVersion < 1) {
    throw new Error("Invalid Antigravity canary approval schema: schemaVersion must be >= 1");
  }
  if (typeof obj.approvedAt !== "string" || !obj.approvedAt.trim()) {
    throw new Error(
      "Invalid Antigravity canary approval schema: approvedAt must be non-empty string"
    );
  }
  if (!obj.profiles || typeof obj.profiles !== "object" || Array.isArray(obj.profiles)) {
    throw new Error("Invalid Antigravity canary approval schema: profiles must be an object");
  }

  const profilesObj = obj.profiles as Record<string, unknown>;
  const parsedProfiles: Partial<Record<AntigravityProfileId, AntigravityCanaryProfileApproval>> =
    {};

  for (const [key, profileRaw] of Object.entries(profilesObj)) {
    if (key !== "cli" && key !== "ide") continue;
    if (!profileRaw || typeof profileRaw !== "object" || Array.isArray(profileRaw)) {
      throw new Error(
        `Invalid Antigravity canary approval schema: profile ${key} must be an object`
      );
    }
    const p = profileRaw as Record<string, unknown>;
    if (typeof p.binaryPath !== "string" || !p.binaryPath.trim()) {
      throw new Error(
        `Invalid Antigravity canary approval schema: profile ${key} missing binaryPath`
      );
    }
    if (typeof p.expectedSha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(p.expectedSha256)) {
      throw new Error(
        `Invalid Antigravity canary approval schema: profile ${key} expectedSha256 must be 64-char hex`
      );
    }
    if (!p.signer || typeof p.signer !== "object" || Array.isArray(p.signer)) {
      throw new Error(`Invalid Antigravity canary approval schema: profile ${key} missing signer`);
    }
    const signer = p.signer as Record<string, unknown>;
    if (
      typeof signer.kind !== "string" ||
      typeof signer.id !== "string" ||
      typeof signer.verified !== "boolean"
    ) {
      throw new Error(`Invalid Antigravity canary approval schema: profile ${key} invalid signer`);
    }

    parsedProfiles[key as AntigravityProfileId] = {
      binaryPath: p.binaryPath,
      expectedSha256: p.expectedSha256.toLowerCase(),
      signer: {
        kind: signer.kind,
        id: signer.id,
        verified: signer.verified,
      },
      expectedVersion: typeof p.expectedVersion === "string" ? p.expectedVersion : undefined,
      platform: typeof p.platform === "string" ? p.platform : undefined,
    };
  }

  return {
    schemaVersion: obj.schemaVersion,
    approvedAt: obj.approvedAt,
    profiles: parsedProfiles,
  };
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function defaultVerifyCodesign(
  binaryPath: string,
  expectedSignerId: string
): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    // Hard Rule #13: Direct argv without shell interpolation
    const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-d", "-r-", binaryPath], {
      shell: false,
    });
    const combined = `${stdout}\n${stderr}`;
    return combined.includes(expectedSignerId);
  } catch {
    return false;
  }
}

export async function verifyApprovedAntigravityBinary(
  binaryPath: string,
  approval: AntigravityCanaryProfileApproval,
  customCodesignVerifier?: (binaryPath: string, expectedSignerId: string) => Promise<boolean>
): Promise<void> {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Antigravity approved binary not found at path: ${binaryPath}`);
  }

  const actualSha256 = await computeFileSha256(binaryPath);
  if (actualSha256.toLowerCase() !== approval.expectedSha256.toLowerCase()) {
    throw new Error(
      `Antigravity binary sha256 mismatch: expected ${approval.expectedSha256}, got ${actualSha256}`
    );
  }

  if (approval.signer.verified && approval.signer.kind === "codesign") {
    const verifier = customCodesignVerifier || defaultVerifyCodesign;
    const isValidSigner = await verifier(binaryPath, approval.signer.id);
    if (!isValidSigner) {
      throw new Error(
        `Antigravity binary signer verification failed: expected codesign id ${approval.signer.id}`
      );
    }
  }
}

export function buildStructuralShapeFromParsed(value: unknown): Record<string, unknown> | string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  const obj = value as Record<string, unknown>;
  const shape: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    shape[k] = buildStructuralShapeFromParsed(v);
  }
  return shape;
}

export function buildObservationFromRequest(
  req: AntigravityObservedRequest
): AntigravityStructuralObservation {
  let pathOnly = req.url;
  try {
    if (req.url.startsWith("http")) {
      const parsed = new URL(req.url);
      pathOnly = parsed.pathname;
    }
  } catch {
    // keep pathOnly
  }

  const headerNames = Array.from(new Set(req.headers.map(([name]) => name.toLowerCase()))).sort();
  let bodyStructuralShape: Record<string, unknown> = {};
  try {
    const parsedBody = JSON.parse(req.bodyUtf8);
    const shape = buildStructuralShapeFromParsed(parsedBody);
    if (typeof shape === "object" && shape !== null && !Array.isArray(shape)) {
      bodyStructuralShape = shape as Record<string, unknown>;
    }
  } catch {
    // Non-JSON or empty
  }

  return {
    method: req.method,
    path: pathOnly,
    headerNames,
    bodyStructuralShape,
  };
}

export function compareStructuralShapes(
  expected: Record<string, unknown> | string,
  actual: Record<string, unknown> | string,
  pointer = ""
): WireDifference[] {
  const diffs: WireDifference[] = [];
  if (typeof expected !== typeof actual) {
    diffs.push({
      path: pointer || "/bodyStructuralShape",
      category: "body",
      reason: `Shape type mismatch: expected ${typeof expected}, got ${typeof actual}`,
    });
    return diffs;
  }

  if (typeof expected === "string") {
    if (expected !== actual) {
      diffs.push({
        path: pointer || "/bodyStructuralShape",
        category: "body",
        reason: `Value type mismatch: expected ${expected}, got ${actual}`,
      });
    }
    return diffs;
  }

  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;

  for (const key of Object.keys(expObj)) {
    const nextPointer = `${pointer}/${key}`;
    if (!(key in actObj)) {
      diffs.push({
        path: nextPointer,
        category: "body",
        reason: `Missing expected structural key: ${key}`,
      });
    } else {
      diffs.push(
        ...compareStructuralShapes(
          expObj[key] as Record<string, unknown> | string,
          actObj[key] as Record<string, unknown> | string,
          nextPointer
        )
      );
    }
  }

  for (const key of Object.keys(actObj)) {
    const nextPointer = `${pointer}/${key}`;
    if (!(key in expObj)) {
      diffs.push({
        path: nextPointer,
        category: "body",
        reason: `Unexpected structural key: ${key}`,
      });
    }
  }

  return diffs;
}

export async function runDesktopObservation(
  profileApproval: AntigravityCanaryProfileApproval,
  probe: AntigravityCanonicalProbe,
  scratchDir: string
): Promise<AntigravityObservedRequest[]> {
  const binary = profileApproval.binaryPath;
  const workspace = path.join(scratchDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const observations: AntigravityObservedRequest[] = [];
  const csrf = "synthetic-local-csrf";
  const metadata = {
    ideName: "antigravity",
    ideVersion: profileApproval.expectedVersion || "2.0.6",
    extensionVersion: profileApproval.expectedVersion || "2.0.6",
    sessionId: "synthetic-canary-session",
    disableTelemetry: true,
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyUtf8 = Buffer.concat(chunks).toString("utf8");

    observations.push({
      method: req.method || "POST",
      url: req.url || "/",
      httpVersion: req.httpVersion || "1.1",
      headers: Array.from({ length: req.rawHeaders.length / 2 }, (_, i) => {
        const name = req.rawHeaders[i * 2];
        return [
          name,
          /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)
            ? "[redacted]"
            : req.rawHeaders[i * 2 + 1],
        ];
      }),
      bodyUtf8,
    });

    if (req.url && req.url.includes("streamGenerateContent")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ACK"}]},"finishReason":"STOP"}]}}\n\n'
      );
      return;
    }

    let response: Record<string, unknown> = {};
    if (req.url && req.url.includes("loadCodeAssist")) {
      response = {
        cloudaicompanionProject: "synthetic-project",
        currentTier: { id: "standard-tier", name: "Standard" },
        allowedTiers: [{ id: "standard-tier", name: "Standard", isDefault: true }],
      };
    } else if (req.url && req.url.includes("fetchAvailableModels")) {
      response = {
        models: {
          "claude-sonnet-4-5": {
            displayName: "Claude Sonnet 4.5",
            model: "claude-sonnet-4-5",
            maxTokens: 16384,
            maxInputTokens: 200000,
          },
        },
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const serverAddress = server.address() as { port: number };
  const endpoint = `http://127.0.0.1:${serverAddress.port}`;

  const portProbe = http.createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", () => resolve()));
  const rpcPort = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));

  const args = [
    "--standalone",
    "--disable_telemetry",
    "--override_ide_name",
    "antigravity",
    "--override_ide_version",
    profileApproval.expectedVersion || "2.0.6",
    "--override_user_agent_name",
    "antigravity",
    "--cloud_code_endpoint",
    endpoint,
    "--api_server_url",
    endpoint,
    "--inference_api_server_url",
    endpoint,
    "--gemini_dir",
    path.join(scratchDir, "gemini"),
    "--app_data_dir",
    "app",
    "--config_dir",
    "config",
    "--http_server_port",
    String(rpcPort),
    "--csrf_token",
    csrf,
  ];

  const sandbox =
    '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(deny mach-lookup (global-name "com.apple.securityd"))';

  // Hard Rule #13: Direct argv without shell interpolation
  const child = spawn("/usr/bin/sandbox-exec", ["-p", sandbox, binary, ...args], {
    cwd: workspace,
    env: {
      PATH: "/usr/bin:/bin",
      TMPDIR: scratchDir,
      LANG: "en_US.UTF-8",
      JETSKI_OAUTH_TOKEN: "synthetic-local-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  async function rpc(method: string, body: unknown) {
    const response = await fetch(
      `http://127.0.0.1:${rpcPort}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrf,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Language server exited early: ${child.exitCode}`);
      try {
        await rpc("GetAuthStatus", {});
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    if (!ready) throw new Error("Language server did not become ready");

    const cascade = await rpc("StartCascade", {
      metadata,
      requestedModel: 333,
      source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
      workspaceUris: [`file://${workspace}`],
    });

    if (cascade && cascade.cascadeId) {
      await rpc("SendUserCascadeMessage", {
        cascadeId: cascade.cascadeId,
        metadata,
        items: [{ text: "Reply with ACK. Do not use tools." }],
        cascadeConfig: { plannerConfig: { planModel: 333, google: {} } },
        blocking: true,
        propagateError: true,
      });
    }
    await delay(1000);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      delay(2000).then(() => child.kill("SIGKILL")),
    ]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return observations;
}

export async function runAntigravityExternalCanary(
  options: CanaryRunOptions
): Promise<CanaryRunResult> {
  const { profile } = options;

  // CLI profile adapter is unavailable by contract until non-interactive invocation protocol is approved
  if (profile === "cli") {
    return {
      status: "blocked",
      exitCode: CANARY_EXIT_CODES.BLOCKED,
      profile,
      reasonCode: "capture_adapter_unavailable",
      message:
        "CLI capture adapter is unavailable: official non-interactive CLI probe protocol is not approved",
    };
  }

  // Load and validate canonical probe
  const probePath =
    options.canonicalProbePath ||
    path.join(process.cwd(), "tests/fixtures/antigravity-wire/canonical-probe.json");
  if (!fs.existsSync(probePath)) {
    return {
      status: "blocked",
      exitCode: CANARY_EXIT_CODES.BLOCKED,
      profile,
      reasonCode: "probe_missing",
      message: `Canonical probe fixture not found: ${probePath}`,
    };
  }

  let canonicalProbe: AntigravityCanonicalProbe;
  try {
    const rawProbe = JSON.parse(fs.readFileSync(probePath, "utf8"));
    validateAntigravityCanonicalProbe(rawProbe);
    canonicalProbe = rawProbe;
  } catch (err: any) {
    return {
      status: "error",
      exitCode: CANARY_EXIT_CODES.ERROR,
      profile,
      reasonCode: "probe_invalid",
      message: `Canonical probe validation failed: ${err?.message || String(err)}`,
    };
  }

  // Load and validate reference manifest
  const manifestPath =
    options.referenceManifestPath ||
    path.join(process.cwd(), `tests/fixtures/antigravity-wire/${profile}-manifest.json`);
  if (!fs.existsSync(manifestPath)) {
    return {
      status: "blocked",
      exitCode: CANARY_EXIT_CODES.BLOCKED,
      profile,
      reasonCode: "manifest_missing",
      message: `Reference manifest fixture not found: ${manifestPath}`,
    };
  }

  let referenceManifest: AntigravityReferenceManifest;
  try {
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    validateAntigravityReferenceManifest(rawManifest);
    referenceManifest = rawManifest;
  } catch (err: any) {
    return {
      status: "error",
      exitCode: CANARY_EXIT_CODES.ERROR,
      profile,
      reasonCode: "manifest_invalid",
      message: `Reference manifest validation failed: ${err?.message || String(err)}`,
    };
  }

  // Check approval
  let approval = options.approval;
  if (!approval && options.approvalPath) {
    if (fs.existsSync(options.approvalPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(options.approvalPath, "utf8"));
        approval = parseAntigravityCanaryApproval(raw);
      } catch (err: any) {
        return {
          status: "blocked",
          exitCode: CANARY_EXIT_CODES.BLOCKED,
          profile,
          reasonCode: "approval_invalid",
          message: `Canary approval file could not be parsed: ${err?.message || String(err)}`,
        };
      }
    }
  }

  if (!approval) {
    return {
      status: "blocked",
      exitCode: CANARY_EXIT_CODES.BLOCKED,
      profile,
      reasonCode: "approval_missing",
      message: "Canary approval is missing: no operator-approved binary configuration provided",
    };
  }

  const profileApproval = approval.profiles[profile];
  if (!profileApproval) {
    return {
      status: "blocked",
      exitCode: CANARY_EXIT_CODES.BLOCKED,
      profile,
      reasonCode: "profile_approval_missing",
      message: `No approved binary configuration found for profile: ${profile}`,
    };
  }

  // Verify binary integrity and codesign
  try {
    await verifyApprovedAntigravityBinary(
      profileApproval.binaryPath,
      profileApproval,
      options.codesignVerifier
    );
  } catch (err: any) {
    return {
      status: "blocked",
      exitCode: CANARY_EXIT_CODES.BLOCKED,
      profile,
      reasonCode: "binary_verification_failed",
      message: `Binary verification failed: ${err?.message || String(err)}`,
    };
  }

  // Setup scratch temp directory
  const baseTmp = options.tempDir || os.tmpdir();
  const scratchDir = fs.mkdtempSync(path.join(baseTmp, `agy-canary-${profile}-`));

  let observedRequests: AntigravityObservedRequest[] = [];
  try {
    const observationRunner = options.runObservation || runDesktopObservation;
    observedRequests = await observationRunner(profileApproval, canonicalProbe, scratchDir);
  } catch (err: any) {
    return {
      status: "error",
      exitCode: CANARY_EXIT_CODES.ERROR,
      profile,
      reasonCode: "observation_failed",
      message: `Observation capture execution failed: ${err?.message || String(err)}`,
    };
  } finally {
    // Always clean up scratchDir containing raw captures
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Ignore scratch cleanup error
    }
  }

  // Transform observed requests into redacted observations
  const observedObservations = observedRequests.map(buildObservationFromRequest);

  // Compare with reference manifest observations
  const differences: WireDifference[] = [];
  const expectedObservations = referenceManifest.observations || [];

  if (expectedObservations.length === 0) {
    differences.push({
      path: "/observations",
      category: "lifecycle",
      reason: "Reference manifest has no recorded observations to compare against",
    });
  } else if (observedObservations.length === 0) {
    differences.push({
      path: "/observations",
      category: "lifecycle",
      reason: "No observations were captured during canary execution",
    });
  } else {
    // Compare observations
    for (const expObs of expectedObservations) {
      const match = observedObservations.find(
        (act) => act.method === expObs.method && act.path === expObs.path
      );
      if (!match) {
        differences.push({
          path: `/observations/${expObs.path}`,
          category: "http",
          reason: `Missing expected observation for ${expObs.method} ${expObs.path}`,
        });
        continue;
      }

      // Check header names
      const expHeaders = new Set(expObs.headerNames.map((h) => h.toLowerCase()));
      const actHeaders = new Set(match.headerNames.map((h) => h.toLowerCase()));
      for (const h of expHeaders) {
        if (!actHeaders.has(h)) {
          differences.push({
            path: `/observations/${expObs.path}/headers/${h}`,
            category: "header",
            reason: `Expected header ${h} missing in observation`,
          });
        }
      }

      // Compare body structural shape
      const shapeDiffs = compareStructuralShapes(
        expObs.bodyStructuralShape,
        match.bodyStructuralShape,
        `/observations/${expObs.path}/bodyStructuralShape`
      );
      differences.push(...shapeDiffs);
    }
  }

  const artifact = {
    provenance: {
      contractId: referenceManifest.contractId,
      profile,
      binaryPath: profileApproval.binaryPath,
      binarySha256: profileApproval.expectedSha256,
      capturedAt: new Date().toISOString(),
      probeInputId: canonicalProbe.inputId,
    },
    observations: observedObservations,
  };

  // Ensure artifact does not contain unredacted secrets / sensitive info
  try {
    assertRedactedAntigravityArtifact(artifact);
  } catch (err: any) {
    return {
      status: "error",
      exitCode: CANARY_EXIT_CODES.ERROR,
      profile,
      reasonCode: "artifact_redaction_failed",
      message: `Artifact failed redaction assertion: ${err?.message || String(err)}`,
    };
  }

  // Write output artifact if requested
  if (options.outputPath) {
    try {
      const outDir = path.dirname(options.outputPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(options.outputPath, JSON.stringify(artifact, null, 2) + "\n", {
        mode: 0o600,
      });
    } catch (err: any) {
      return {
        status: "error",
        exitCode: CANARY_EXIT_CODES.ERROR,
        profile,
        reasonCode: "artifact_write_failed",
        message: `Failed to write artifact: ${err?.message || String(err)}`,
      };
    }
  }

  if (differences.length > 0) {
    return {
      status: "drift",
      exitCode: CANARY_EXIT_CODES.DRIFT,
      profile,
      reasonCode: "wire_drift_detected",
      message: `Observed wire requests differ from baseline manifest (${differences.length} differences)`,
      differences,
      artifact,
    };
  }

  return {
    status: "pass",
    exitCode: CANARY_EXIT_CODES.PASS,
    profile,
    reasonCode: "verified",
    message: "Canary verification passed: observed loopback requests match approved baseline",
    artifact,
  };
}
