import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createAntigravityClientContext,
  getAntigravityClientContract,
} from "../../open-sse/config/antigravityClient.ts";
import { CLI_FINGERPRINTS, isCliCompatEnabled } from "../../open-sse/config/cliFingerprints.ts";
import { ANTIGRAVITY_CLIENT_PROFILE_VALUES } from "../../src/shared/constants/antigravityClientProfile.ts";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readProjectFile(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

const docs = {
  environment: readProjectFile("docs/reference/ENVIRONMENT.md"),
  stealth: readProjectFile("docs/security/STEALTH_GUIDE.md"),
  cliTools: readProjectFile("docs/reference/CLI-TOOLS.md"),
  onboarding: readProjectFile("docs/guides/ANTIGRAVITY-ONBOARDING.md"),
};

const runtimeContractSource = readProjectFile("open-sse/config/antigravityClient.ts");
const diagnosticsSource = readProjectFile(
  "open-sse/services/antigravityCompatibilityDiagnostics.ts"
);
const antigravityExecutorSource = readProjectFile("open-sse/executors/antigravity.ts");
function extractSection(document: string, heading: string, nextHeading: string): string {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `missing documentation section: ${heading}`);
  const end = document.indexOf(nextHeading, start + heading.length);
  return document.slice(start, end === -1 ? document.length : end);
}

function deriveStringUnion(source: string, field: string): string[] {
  const match = source.match(new RegExp(`${field}:\\s*((?:"[^"\\n]+"\\s*\\|\\s*)*"[^"\\n]+")`));
  assert.ok(match, `missing runtime ${field} union`);
  return [...match[1].matchAll(/"([^"\\n]+)"/g)].map((entry) => entry[1]);
}

const environmentProfileSection = extractSection(
  docs.environment,
  "## 12. Provider User-Agent Overrides",
  "## 13. CLI Fingerprint Compatibility"
);
const environmentFingerprintSection = extractSection(
  docs.environment,
  "## 13. CLI Fingerprint Compatibility",
  "## 14. API Key Providers"
);
const cliSourceSection = extractSection(
  docs.cliTools,
  "## Source of Truth",
  "## 1. CLI Code's Catalog"
);
const cliCatalogSection = extractSection(
  docs.cliTools,
  "## 1. CLI Code's Catalog",
  "## 2. CLI Agents Catalog"
);
const stealthProfileSection = extractSection(
  docs.stealth,
  "## Antigravity Stealth",
  "### `antigravityHeaderScrub.ts`"
);
const runtimeSurfaces = deriveStringUnion(diagnosticsSource, "surface");

function withEnvValue(name: string, value: string | undefined, callback: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("runtime profile contracts, provenance, defaults, and supported surfaces stay documented", () => {
  assert.match(runtimeContractSource, /AntigravityClientContract/);
  assert.match(runtimeContractSource, /DEFAULT_PROFILE_BY_PROVIDER/);

  for (const profile of ANTIGRAVITY_CLIENT_PROFILE_VALUES) {
    const contract = getAntigravityClientContract(profile);
    assert.equal(contract.profile, profile);
    assert.equal(contract.source, "synthetic-only");
    assert.equal(contract.baselineVersion, null);
    assert.equal(contract.minimumSupportedVersion, null);
    assert.equal(contract.fixtureId, `${contract.contractId}`);

    const context = createAntigravityClientContext(profile === "cli" ? "agy" : "antigravity", {
      connectionId: `drift-test-${profile}`,
    });
    assert.equal(context.profile, profile);
    assert.equal(context.contractId, contract.contractId);
    assert.equal(context.observedVersion, null);
    assert.equal(context.versionState, "unverified");
    assert.equal(context.source, "provider-default");
  }

  assert.match(environmentProfileSection, /canonical profile IDs are `cli` and `ide`/i);
  assert.match(environmentProfileSection, /`agy` provider default is the `cli` profile/i);
  assert.match(environmentProfileSection, /`antigravity` provider default is the `ide` profile/i);
  assert.match(environmentProfileSection, /synthetic-only.*unverified/i);

  for (const surface of runtimeSurfaces) {
    assert.match(
      cliCatalogSection,
      new RegExp(`\\b${surface}\\b`, "i"),
      `${surface} surface is undocumented`
    );
  }
});

test("CLI_COMPAT_ANTIGRAVITY remains an explicit opt-in ordering switch", () => {
  assert.ok(CLI_FINGERPRINTS.antigravity, "runtime Antigravity fingerprint is missing");

  withEnvValue("CLI_COMPAT_ANTIGRAVITY", undefined, () => {
    withEnvValue("CLI_COMPAT_ALL", undefined, () => {
      assert.equal(isCliCompatEnabled("antigravity"), false);
    });
  });
  withEnvValue("CLI_COMPAT_ANTIGRAVITY", "1", () => {
    assert.equal(isCliCompatEnabled("antigravity"), true);
  });

  assert.match(environmentFingerprintSection, /CLI_COMPAT_ANTIGRAVITY/);
  assert.match(environmentFingerprintSection, /opt[- ]?in/i);
  assert.match(environmentFingerprintSection, /header(?:s)?[^\n]+(?:body|field)|body[^\n]+header/i);
  assert.match(
    environmentFingerprintSection,
    /synthetic-only|unverified|drift warning|not[^\n]*(?:official|bypass)/i
  );
});

test("catalog and docs preserve Antigravity MITM and profile capability boundaries", () => {
  const antigravity = CLI_TOOLS.antigravity;
  assert.ok(antigravity, "Antigravity catalog entry is missing");
  assert.equal(antigravity.configType, "mitm");
  assert.equal(antigravity.baseUrlSupport, "none");

  assert.match(
    cliCatalogSection,
    /antigravity\s+\|\s+Antigravity\s+\|\s+Google\s+\|\s+none\s+\|\s+mitm/i
  );
  assert.match(cliSourceSection, /configType:\s*`mitm`|configType.*mitm/i);
  assert.match(cliSourceSection, /baseUrlSupport:\s*`none`|baseUrlSupport.*none/i);
  assert.match(cliSourceSection, /profile(?:s)?[^\n]*(?:cli|ide)|(?:cli|ide)[^\n]*profile/i);
  assert.match(cliSourceSection, /antigravityHeaders\.ts|antigravityClient\.ts/);
});

test("docs point to runtime-generated identity and keep bootstrap separate from fingerprint bypass", () => {
  assert.match(environmentProfileSection, /antigravityHeaders\.ts/);
  assert.doesNotMatch(environmentProfileSection, /`antigravity\/\d+\.\d+\.\d+[^`]*`/);
  assert.doesNotMatch(environmentProfileSection, /google-api-nodejs-client\/\d+\.\d+\.\d+/);
  assert.match(
    environmentProfileSection,
    /ANTIGRAVITY_USER_AGENT[^\n]*source of truth|does not[^\n]*override[^\n]*(?:native|content)|native[^\n]*context[^\n]*source of truth/i
  );
  assert.match(
    environmentProfileSection,
    /generic[^\n]*(?:provider lookup|executor)|general[^\n]*executor/i
  );
  assert.match(antigravityExecutorSource, /class AntigravityExecutor extends BaseExecutor/);
  assert.match(antigravityExecutorSource, /buildContextHeaders[\s\S]*getAntigravityContentHeaders/);
  assert.match(
    antigravityExecutorSource,
    /buildHeaders\([\s\S]*getAntigravityClientContext\(this\.provider, credentials\)/
  );
  assert.match(
    environmentProfileSection,
    /AntigravityExecutor[^\n]*(?:direct|profile\/context)[^\n]*(?:header|builder)|profile\/context[^\n]*(?:direct|native)[^\n]*header/i
  );
  assert.match(stealthProfileSection, /approved|operator-controlled|account compatibility/i);
  assert.match(stealthProfileSection, /not[^\n]*(?:bypass|evad|circumvent)/i);
  assert.match(docs.onboarding, /projectId/);
  assert.match(docs.onboarding, /agy login/);
  assert.match(
    docs.onboarding,
    /bootstrap workaround|bootstrap[^\n]*(?:not|does not)[^\n]*(?:fingerprint|bypass)|fingerprint[^\n]*(?:not|does not)[^\n]*(?:bypass|workaround)/i
  );
});
