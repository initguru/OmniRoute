import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_COMPATIBILITY_ERROR_CODE,
  assertAntigravityClientContextCompatible,
  classifyAntigravityVersion,
  createAntigravityClientContext,
  getAntigravityClientContract,
  type AntigravityClientContract,
} from "../../open-sse/config/antigravityClient.ts";
import { normalizeAntigravityVersion } from "../../open-sse/services/antigravityVersion.ts";

const syntheticContract: AntigravityClientContract = {
  profile: "cli",
  contractId: "synthetic-contract",
  baselineVersion: "1.1.5",
  minimumSupportedVersion: "1.1.0",
  fixtureId: "synthetic-approved-fixture",
  source: "approved-capture",
};

test("classifies supported, drift, unsupported, unverified, and invalid versions", () => {
  assert.equal(classifyAntigravityVersion("1.1.5", syntheticContract), "supported");
  assert.equal(classifyAntigravityVersion("1.1.6", syntheticContract), "drift");
  assert.equal(classifyAntigravityVersion("1.0.9", syntheticContract), "unsupported");
  assert.equal(classifyAntigravityVersion(null, syntheticContract), "unverified");
  assert.equal(classifyAntigravityVersion("not-a-version", syntheticContract), "invalid");
});

test("contract-facing version parsing rejects suffixes, extra components, and leading zeros", () => {
  for (const malformed of ["1.1.5.999", "1.1.5-foo", "01.1.5", "1.01.5", "1.1.05"]) {
    assert.equal(normalizeAntigravityVersion(malformed), null, malformed);
    assert.equal(classifyAntigravityVersion(malformed, syntheticContract), "invalid", malformed);
  }
  assert.equal(normalizeAntigravityVersion("v1.1.5"), "1.1.5");
});

test("approved contracts reject malformed metadata instead of becoming unverified", () => {
  for (const contract of [
    { ...syntheticContract, source: "approved-capture" as const, baselineVersion: null },
    { ...syntheticContract, source: "approved-capture" as const, minimumSupportedVersion: null },
    { ...syntheticContract, source: "approved-capture" as const, fixtureId: null },
    { ...syntheticContract, source: "approved-capture" as const, fixtureId: "" },
    { ...syntheticContract, source: "approved-capture" as const, fixtureId: "   " },
    { ...syntheticContract, source: "approved-capture" as const, contractId: "" },
  ]) {
    assert.throws(
      () => classifyAntigravityVersion("1.1.5", contract),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
    );
  }
});

test("synthetic-only contracts do not invent a minimum or baseline version", () => {
  const cli = getAntigravityClientContract("cli");
  const ide = getAntigravityClientContract("ide");

  assert.equal(cli.source, "synthetic-only");
  assert.equal(ide.source, "synthetic-only");
  assert.equal(cli.minimumSupportedVersion, null);
  assert.equal(cli.baselineVersion, null);
  assert.equal(ide.minimumSupportedVersion, null);
  assert.equal(ide.baselineVersion, null);
  assert.notEqual(cli.contractId, ide.contractId);
  assert.equal(classifyAntigravityVersion("1.1.5", cli), "unverified");
});

test("explicit null observed version keeps provider-default provenance", () => {
  const context = createAntigravityClientContext("agy", { connectionId: "connection-cli" }, null);
  assert.equal(context.source, "provider-default");
  assert.equal(context.observedVersion, null);
  assert.equal(context.versionState, "unverified");
});

test("provider defaults normalize agy to CLI and antigravity to IDE", () => {
  const cli = createAntigravityClientContext("agy", { connectionId: "connection-cli" });
  const ide = createAntigravityClientContext("antigravity", { connectionId: "connection-ide" });

  assert.equal(cli.profile, "cli");
  assert.equal(cli.source, "provider-default");
  assert.equal(ide.profile, "ide");
  assert.equal(ide.source, "provider-default");
  assert.equal(cli.observedVersion, null);
  assert.equal(cli.versionState, "unverified");
});

test("a persisted credential profile is durable and context contains no credential material", () => {
  const context = createAntigravityClientContext(
    "antigravity",
    { connectionId: "connection-cli", providerSpecificData: { clientProfile: "harness" } },
    "1.1.5"
  );

  assert.deepEqual(Object.keys(context).sort(), [
    "contractId",
    "observedVersion",
    "profile",
    "source",
    "versionState",
  ]);
  assert.equal(context.profile, "cli");
  assert.equal(context.source, "credential");
  assert.equal(context.observedVersion, "1.1.5");
  assert.equal(context.versionState, "unverified");
});

test("unknown providers and credential profiles fail with a stable compatibility error", () => {
  assert.throws(
    () => createAntigravityClientContext("unknown-provider", { connectionId: "connection" }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
  );
  assert.throws(
    () =>
      createAntigravityClientContext("agy", {
        connectionId: "connection",
        providerSpecificData: { clientProfile: "unknown-profile" },
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
  );
});

test("synthetic environment versions remain warning-compatible when asserted", () => {
  const context = createAntigravityClientContext("agy", { connectionId: "review" }, "1.1.5");

  assert.equal(context.source, "environment");
  assert.equal(context.observedVersion, "1.1.5");
  assert.equal(context.versionState, "unverified");
  assert.doesNotThrow(() => assertAntigravityClientContextCompatible(context));
});

test("context assertion rejects forged provenance, state, and contract identity", () => {
  const context = createAntigravityClientContext("agy", { connectionId: "connection" });
  for (const forged of [
    { ...context, source: "not-a-source" },
    { ...context, contractId: "forged-contract" },
    { ...context, profile: "ide" },
    { ...context, versionState: "supported" },
    { ...context, observedVersion: 42 },
    { ...context, source: "environment", observedVersion: null },
    { ...context, observedVersion: null, versionState: "drift" },
  ]) {
    assert.throws(
      () => assertAntigravityClientContextCompatible(forged as never),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
    );
  }
});

test("unsupported and invalid states fail while drift and unverified remain warnings", () => {
  const unsupported = {
    ...syntheticContract,
    profile: "cli" as const,
  };
  const invalid = { ...unsupported };

  assert.throws(
    () =>
      assertAntigravityClientContextCompatible({
        profile: "cli",
        contractId: unsupported.contractId,
        observedVersion: "1.0.9",
        versionState: "unsupported",
        source: "environment",
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
  );
  assert.throws(
    () =>
      assertAntigravityClientContextCompatible({
        profile: invalid.profile,
        contractId: invalid.contractId,
        observedVersion: "malformed",
        versionState: "invalid",
        source: "environment",
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
  );
  assert.throws(
    () =>
      assertAntigravityClientContextCompatible({
        profile: "cli",
        contractId: syntheticContract.contractId,
        observedVersion: "1.1.6",
        versionState: "drift",
        source: "environment",
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === ANTIGRAVITY_COMPATIBILITY_ERROR_CODE
  );
  assert.doesNotThrow(() =>
    assertAntigravityClientContextCompatible({
      profile: "cli",
      contractId: getAntigravityClientContract("cli").contractId,
      observedVersion: null,
      versionState: "unverified",
      source: "provider-default",
    })
  );
});
