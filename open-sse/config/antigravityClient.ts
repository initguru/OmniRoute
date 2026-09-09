import type { ProviderCredentials } from "../executors/base.ts";
import {
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  type AntigravityProfileId,
} from "@/shared/constants/antigravityClientProfile";
import {
  compareAntigravityVersions,
  normalizeAntigravityVersion,
} from "../services/antigravityVersion.ts";

export type { AntigravityProfileId } from "@/shared/constants/antigravityClientProfile";

export type AntigravityVersionState =
  "supported" | "drift" | "unverified" | "unsupported" | "invalid";

export type AntigravityClientContract = {
  profile: AntigravityProfileId;
  contractId: string;
  baselineVersion: string | null;
  minimumSupportedVersion: string | null;
  fixtureId: string | null;
  source: "approved-capture" | "synthetic-only";
};

export type AntigravityClientContext = {
  profile: AntigravityProfileId;
  contractId: string;
  observedVersion: string | null;
  versionState: AntigravityVersionState;
  source: "credential" | "provider-default" | "environment";
};

export const ANTIGRAVITY_COMPATIBILITY_ERROR_CODE = "ANTIGRAVITY_COMPATIBILITY_ERROR" as const;

const SYNTHETIC_CONTRACTS: Readonly<Record<AntigravityProfileId, AntigravityClientContract>> = {
  cli: {
    profile: "cli",
    contractId: "antigravity-wire-cli-synthetic-v1",
    baselineVersion: null,
    minimumSupportedVersion: null,
    fixtureId: "antigravity-wire-cli-synthetic-v1",
    source: "synthetic-only",
  },
  ide: {
    profile: "ide",
    contractId: "antigravity-wire-ide-synthetic-v1",
    baselineVersion: null,
    minimumSupportedVersion: null,
    fixtureId: "antigravity-wire-ide-synthetic-v1",
    source: "synthetic-only",
  },
};

const DEFAULT_PROFILE_BY_PROVIDER: Readonly<Record<string, AntigravityProfileId>> = {
  agy: "cli",
  antigravity: "ide",
};

const PROFILE_VALUES = new Set<string>(ANTIGRAVITY_CLIENT_PROFILE_VALUES);

class AntigravityCompatibilityError extends Error {
  readonly code = ANTIGRAVITY_COMPATIBILITY_ERROR_CODE;

  constructor(reason: "provider" | "profile" | "version" | "contract") {
    super(`Antigravity compatibility contract rejected ${reason}`);
    this.name = "AntigravityCompatibilityError";
  }
}

function isProfileId(value: unknown): value is AntigravityProfileId {
  return typeof value === "string" && PROFILE_VALUES.has(value);
}

function normalizeProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const provider = value.trim().toLowerCase();
  return provider === "agy" || provider === "antigravity" ? provider : null;
}

function readCredentialProfile(credentials?: ProviderCredentials | null): {
  profile: AntigravityProfileId | null;
  present: boolean;
} {
  const providerSpecificData = credentials?.providerSpecificData;
  if (!providerSpecificData || typeof providerSpecificData !== "object") {
    return { profile: null, present: false };
  }
  const raw = providerSpecificData.clientProfile;
  if (raw === undefined || raw === null) return { profile: null, present: false };
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "harness" || normalized === "sdk") return { profile: "cli", present: true };
    if (isProfileId(normalized)) return { profile: normalized, present: true };
  }
  return { profile: null, present: true };
}

function normalizeObservedVersion(observedVersion: unknown): string | null {
  if (observedVersion === null || observedVersion === undefined) return null;
  return normalizeAntigravityVersion(observedVersion);
}

function validateAntigravityClientContract(contract: AntigravityClientContract): void {
  if (!contract || !isProfileId(contract.profile)) {
    throw new AntigravityCompatibilityError("contract");
  }
  if (typeof contract.contractId !== "string" || contract.contractId.trim().length === 0) {
    throw new AntigravityCompatibilityError("contract");
  }
  if (contract.source === "synthetic-only") {
    if (
      contract.baselineVersion !== null ||
      contract.minimumSupportedVersion !== null ||
      (contract.fixtureId !== null && typeof contract.fixtureId !== "string")
    ) {
      throw new AntigravityCompatibilityError("contract");
    }
    return;
  }
  if (
    contract.source !== "approved-capture" ||
    typeof contract.fixtureId !== "string" ||
    contract.fixtureId.trim().length === 0
  ) {
    throw new AntigravityCompatibilityError("contract");
  }
  const baseline = normalizeObservedVersion(contract.baselineVersion);
  const minimum = normalizeObservedVersion(contract.minimumSupportedVersion);
  if (!baseline || !minimum || compareAntigravityVersions(minimum, baseline) > 0) {
    throw new AntigravityCompatibilityError("contract");
  }
}

function getCanonicalContract(profile: AntigravityProfileId): AntigravityClientContract {
  return SYNTHETIC_CONTRACTS[profile];
}

export function getAntigravityClientContract(
  profile: AntigravityProfileId
): AntigravityClientContract {
  if (!isProfileId(profile)) throw new AntigravityCompatibilityError("profile");
  const contract = { ...SYNTHETIC_CONTRACTS[profile] };
  validateAntigravityClientContract(contract);
  return contract;
}

export function classifyAntigravityVersion(
  observedVersion: unknown,
  contract: AntigravityClientContract
): AntigravityVersionState {
  validateAntigravityClientContract(contract);
  if (observedVersion === null || observedVersion === undefined) {
    return "unverified";
  }
  const normalized = normalizeObservedVersion(observedVersion);
  if (!normalized) return "invalid";

  const minimum = normalizeObservedVersion(contract.minimumSupportedVersion);
  const baseline = normalizeObservedVersion(contract.baselineVersion);
  if (contract.source === "synthetic-only") return "unverified";
  if (!minimum || !baseline) throw new AntigravityCompatibilityError("contract");
  if (compareAntigravityVersions(normalized, minimum) < 0) return "unsupported";
  return compareAntigravityVersions(normalized, baseline) === 0 ? "supported" : "drift";
}

export function createAntigravityClientContext(
  provider: string,
  credentials: ProviderCredentials | null | undefined,
  observedVersion?: string | null
): AntigravityClientContext {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) throw new AntigravityCompatibilityError("provider");

  const credentialProfile = readCredentialProfile(credentials);
  if (credentialProfile.present && !credentialProfile.profile) {
    throw new AntigravityCompatibilityError("profile");
  }

  const profile = credentialProfile.profile ?? DEFAULT_PROFILE_BY_PROVIDER[normalizedProvider];
  const source: AntigravityClientContext["source"] = credentialProfile.profile
    ? "credential"
    : observedVersion !== undefined && observedVersion !== null
      ? "environment"
      : "provider-default";
  const contract = getAntigravityClientContract(profile);
  const normalizedVersion = normalizeObservedVersion(observedVersion);
  const versionState = classifyAntigravityVersion(observedVersion, contract);
  if (versionState === "invalid" || versionState === "unsupported") {
    throw new AntigravityCompatibilityError("version");
  }

  return {
    profile,
    contractId: contract.contractId,
    observedVersion: normalizedVersion,
    versionState,
    source,
  };
}

export function assertAntigravityClientContextCompatible(context: AntigravityClientContext): void {
  if (!context || !isProfileId(context.profile)) {
    throw new AntigravityCompatibilityError("profile");
  }
  const canonical = getCanonicalContract(context.profile);
  validateAntigravityClientContract(canonical);
  if (context.contractId !== canonical.contractId) {
    throw new AntigravityCompatibilityError("contract");
  }
  if (
    context.source !== "credential" &&
    context.source !== "provider-default" &&
    context.source !== "environment"
  ) {
    throw new AntigravityCompatibilityError("profile");
  }
  if (
    context.observedVersion !== null &&
    (typeof context.observedVersion !== "string" ||
      normalizeObservedVersion(context.observedVersion) !== context.observedVersion)
  ) {
    throw new AntigravityCompatibilityError("version");
  }
  if (
    context.source === "provider-default" &&
    (context.observedVersion !== null || context.versionState !== "unverified")
  ) {
    throw new AntigravityCompatibilityError("profile");
  }
  if (
    context.source === "environment" &&
    context.observedVersion === null
  ) {
    throw new AntigravityCompatibilityError("profile");
  }

  const expectedState = classifyAntigravityVersion(context.observedVersion, canonical);
  if (context.versionState !== expectedState) {
    throw new AntigravityCompatibilityError("version");
  }
  if (context.versionState === "invalid" || context.versionState === "unsupported") {
    throw new AntigravityCompatibilityError("version");
  }
}

export { AntigravityCompatibilityError };
