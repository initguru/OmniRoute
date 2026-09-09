#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { tsImport } = await import("tsx/esm/api");
const { classifyAntigravityCompatibilityError } = await tsImport(
  "../../open-sse/services/errorClassifier.ts",
  import.meta.url
);
const { sanitizeErrorMessage } = await tsImport(
  "../../open-sse/utils/errorSanitization.ts",
  import.meta.url
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = path.join(ROOT, "tests/fixtures/antigravity-wire");
const PROFILES = new Set(["cli", "ide"]);
const SURFACES = ["oauth", "bootstrap", "content", "usage", "credits", "image", "mitm"];
const SURFACE_SET = new Set(SURFACES);
const LIVE_ENV = "ANTIGRAVITY_COMPAT_LIVE";
const SYNTHETIC_TOKEN = "synthetictoken";
const SYNTHETIC_PROJECT = "synthetic-project";
const SYNTHETIC_PROMPT = "compatibility probe";
const SYNTHETIC_VERSION = Object.freeze({ cli: "1.1.5", ide: "2.1.1" });
const SYNTHETIC_OUTPUT_BUDGET = 16;
const SYNTHETIC_ERROR_CASES = Object.freeze([
  { name: "project_route", status: 403, body: "has not been used in project" },
  { name: "geo_eligibility", status: 400, body: "user location is not supported" },
  { name: "schema_rejection", status: 400, body: "invalid JSON payload: unknown field" },
  { name: "auth_failure", status: 401, body: "Unauthorized" },
  { name: "quota_rate_limit", status: 429, body: "Individual quota reached" },
  { name: "transport_failure", status: 503, body: "upstream unavailable" },
]);
const LIVE_ERROR_CLASSES = new Set([
  "schema_rejection",
  "auth_failure",
  "project_route",
  "geo_eligibility",
  "quota_rate_limit",
  "transport_failure",
]);
function usage() {
  return "Usage: node scripts/ad-hoc/antigravity-compat-smoke.mjs --profile <cli|ide> --surface <surface|all> [--live --confirm-authorized-account]";
}

function parseArgs(argv) {
  const options = {
    live: false,
    confirmAuthorizedAccount: false,
    profile: null,
    surface: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--live":
        options.live = true;
        break;
      case "--confirm-authorized-account":
        options.confirmAuthorizedAccount = true;
        break;
      case "--profile":
        options.profile = argv[++index] ?? null;
        break;
      case "--surface":
        options.surface = argv[++index] ?? null;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error("unknown option");
    }
  }
  return options;
}

function failClosed(message) {
  console.error(`[antigravity-compat] ${message}`);
  console.error(usage());
  process.exitCode = 2;
}

function readManifest(profile) {
  const manifestPath = path.join(FIXTURE_DIR, `${profile}-manifest.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.profile, profile);
  assert.equal(manifest.source, "synthetic-only");
  assert.equal(typeof manifest.contractId, "string");
  assert.equal(manifest.clientVersion, "unknown");
  assert.deepEqual(manifest.surfaces, SURFACES);
  return manifest;
}

function profileUserAgent(profile) {
  return profile === "cli"
    ? `antigravity/cli/${SYNTHETIC_VERSION.cli} (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)`
    : `antigravity/ide/${SYNTHETIC_VERSION.ide} darwin/arm64`;
}

function surfacePath(surface) {
  switch (surface) {
    case "oauth":
      return "/oauth2/token";
    case "bootstrap":
      return "/v1internal:loadCodeAssist";
    case "usage":
      return "/v1internal:fetchAvailableModels";
    case "content":
    case "credits":
    case "image":
    case "mitm":
      return "/v1internal:streamGenerateContent?alt=sse";
    default:
      throw new Error("unsupported surface");
  }
}

function requestBody(profile, manifest, surface) {
  const context = {
    profile,
    contractId: manifest.contractId,
    observedVersion: SYNTHETIC_VERSION[profile],
    versionState: "unverified",
    source: "credential",
  };
  const request = {
    contents: [{ role: "user", parts: [{ text: SYNTHETIC_PROMPT }] }],
    generationConfig: { maxOutputTokens: SYNTHETIC_OUTPUT_BUDGET },
  };
  return {
    project: SYNTHETIC_PROJECT,
    request,
    model: surface === "image" ? "gemini-3.1-flash-image" : "gemini-2.5-flash",
    userAgent: "antigravity",
    requestType: surface === "image" ? "image_gen" : "agent",
    surface,
    compatibilityContext: context,
  };
}

function requestHeaders(profile) {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${SYNTHETIC_TOKEN}`,
    "User-Agent": profileUserAgent(profile),
    "X-Goog-User-Project": SYNTHETIC_PROJECT,
  };
}

function classifyFailure({ status = 0, body = "", wireMismatch = false } = {}) {
  if (wireMismatch) return "wire_mismatch";
  const errorClass = classifyAntigravityCompatibilityError(
    status,
    sanitizeErrorMessage(String(body).slice(0, 4096)),
    "antigravity"
  );
  return errorClass === "transport" ? "transport_failure" : errorClass;
}

function assertSyntheticUrl(url, baseUrl) {
  const parsed = new URL(url);
  const allowed = new URL(baseUrl);
  if (
    parsed.protocol !== allowed.protocol ||
    parsed.hostname !== allowed.hostname ||
    parsed.port !== allowed.port
  ) {
    throw new Error("synthetic URL allowlist rejected destination");
  }
}

async function startSyntheticReceiver() {
  const captures = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const errorCase = SYNTHETIC_ERROR_CASES.find(
        (candidate) => pathname === `/synthetic-error/${candidate.name}`
      );
      if (errorCase) {
        response.writeHead(errorCase.status, { "Content-Type": "text/plain" });
        response.end(errorCase.body);
        return;
      }
      captures.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headerNames: request.rawHeaders
          .filter((_, index) => index % 2 === 0)
          .map((name) => name.toLowerCase()),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end("data: synthetic-receiver\\n\\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("synthetic receiver did not expose a TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captures,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function installFetchAllowlist(baseUrl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const destination = String(input instanceof Request ? input.url : input);
    assertSyntheticUrl(destination, baseUrl);
    return originalFetch(input, { ...init, redirect: "error" });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function summarizeCapture(capture, profile, manifest, surface) {
  const body = JSON.parse(capture.body);
  const context = body.compatibilityContext;
  const headerNames = new Set(capture.headerNames);
  const wireMismatch =
    capture.method !== "POST" ||
    capture.path !== surfacePath(surface) ||
    body.surface !== surface ||
    body.userAgent !== "antigravity" ||
    context?.profile !== profile ||
    context?.contractId !== manifest.contractId ||
    context?.observedVersion !== SYNTHETIC_VERSION[profile] ||
    headerNames.has("authorization") === false ||
    headerNames.has("user-agent") === false;
  return {
    status: wireMismatch ? "failure" : "pass",
    errorClass: wireMismatch ? classifyFailure({ wireMismatch: true }) : null,
    requestSummary: {
      method: capture.method,
      bodyKeys: Object.keys(body).sort(),
      headerNames: [...headerNames].sort(),
    },
  };
}

async function printClassifierRegressionCases(receiver) {
  for (const testCase of SYNTHETIC_ERROR_CASES) {
    const response = await fetch(`${receiver.baseUrl}/synthetic-error/${testCase.name}`, {
      method: "POST",
      body: "{}",
    });
    const responseBody = (await response.text()).slice(0, 4096);
    const errorClass = classifyFailure({ status: response.status, body: responseBody });
    console.log(JSON.stringify({ mode: "synthetic-classifier", case: testCase.name, errorClass }));
    if (!LIVE_ERROR_CLASSES.has(errorClass) || errorClass !== testCase.name) process.exitCode = 1;
  }
}

async function runSynthetic({ profile, surfaces }) {
  const manifest = readManifest(profile);
  const receiver = await startSyntheticReceiver();
  const restoreFetch = installFetchAllowlist(receiver.baseUrl);
  const mode = "synthetic";
  await printClassifierRegressionCases(receiver);
  console.log(
    JSON.stringify({
      mode,
      profile,
      version: SYNTHETIC_VERSION[profile],
      contractId: manifest.contractId,
      surfaces,
    })
  );

  try {
    for (const surface of surfaces) {
      const body = requestBody(profile, manifest, surface);
      const url = `${receiver.baseUrl}${surfacePath(surface)}`;
      assertSyntheticUrl(url, receiver.baseUrl);
      let result;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: requestHeaders(profile),
          body: JSON.stringify(body),
        });
        const responseBody = (await response.text()).slice(0, 4096);
        result = response.ok
          ? summarizeCapture(receiver.captures.at(-1), profile, manifest, surface)
          : {
              status: "failure",
              errorClass: classifyFailure({ status: response.status, body: responseBody }),
            };
      } catch (error) {
        result = {
          status: "failure",
          errorClass: classifyFailure({
            status: 0,
            body: sanitizeErrorMessage(error instanceof Error ? error.message : ""),
          }),
        };
      }
      console.log(
        JSON.stringify({
          mode,
          profile,
          version: SYNTHETIC_VERSION[profile],
          contractId: manifest.contractId,
          surface,
          status: result.status,
          errorClass: result.errorClass,
        })
      );
      if (result.status !== "pass") process.exitCode = 1;
    }
  } finally {
    restoreFetch();
    await receiver.close();
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
} else if (
  !PROFILES.has(options.profile) ||
  typeof options.surface !== "string" ||
  (!SURFACE_SET.has(options.surface) && options.surface !== "all")
) {
  failClosed("profile and surface are required and must be allowlisted");
} else if (options.live && process.env[LIVE_ENV] !== "1") {
  failClosed("live mode requires ANTIGRAVITY_COMPAT_LIVE=1");
} else if (!options.live && process.env[LIVE_ENV] === "1") {
  failClosed("ANTIGRAVITY_COMPAT_LIVE=1 requires --live");
} else if (options.live && !options.confirmAuthorizedAccount) {
  failClosed("live mode requires --confirm-authorized-account");
} else if (options.live) {
  const surfaces = options.surface === "all" ? SURFACES : [options.surface];
  const omittedSurfaces = SURFACES.filter((surface) => !surfaces.includes(surface));
  console.error(
    JSON.stringify({
      mode: "live-authorized-blocked",
      profile: options.profile,
      requestedSurfaces: surfaces,
      omittedLiveSurfaces: Object.fromEntries(
        omittedSurfaces.map((surface) => [surface, "not_run"])
      ),
      liveValidation: "not_run",
      result: "blocked",
      note: "live upstream calls are disabled; no local synthetic substitute was started",
    })
  );
  process.exitCode = 3;
} else {
  const surfaces = options.surface === "all" ? SURFACES : [options.surface];
  await runSynthetic({ profile: options.profile, surfaces });
}
