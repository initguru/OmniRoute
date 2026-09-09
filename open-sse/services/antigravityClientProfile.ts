import {
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
import {
  assertAntigravityClientContextCompatible,
  createAntigravityClientContext,
  type AntigravityClientContext,
} from "../config/antigravityClient.ts";
import type { ProviderCredentials } from "../executors/base.ts";
import {
  getAntigravityContentHeaders,
  resolveAntigravityClientProfile,
} from "./antigravityHeaders.ts";
import type { AntigravityCredentialsLike } from "./antigravityIdentity.ts";
import {
  ANTIGRAVITY_CLI_FALLBACK_VERSION,
  ANTIGRAVITY_IDE_FALLBACK_VERSION,
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
} from "./antigravityVersion.ts";

export {
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
export {
  ANTIGRAVITY_COMPATIBILITY_ERROR_CODE,
  assertAntigravityClientContextCompatible,
  createAntigravityClientContext,
  getAntigravityClientContract,
  type AntigravityClientContext,
  type AntigravityClientContract,
  type AntigravityVersionState,
} from "../config/antigravityClient.ts";

type AntigravityProfileCredentials = AntigravityCredentialsLike & {
  providerSpecificData?: Record<string, unknown> | null;
};

const ABSENT_CONTENT_IDENTITY_HEADERS = [
  "x-client-name",
  "x-client-version",
  "x-machine-id",
  "x-vscode-sessionid",
  "X-Goog-Api-Client",
  "Client-Metadata",
] as const;

export function getAntigravityClientProfile(
  credentials?: AntigravityProfileCredentials | null
): AntigravityClientProfile {
  const fromProviderData =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? credentials.providerSpecificData.clientProfile
      : undefined;

  return normalizeAntigravityClientProfile(fromProviderData);
}

function readPersistedContextProfile(value: unknown): AntigravityClientProfile {
  return resolveAntigravityClientProfile(value);
}

export function resolveAntigravityClientVersion(
  profile: AntigravityClientProfile
): Promise<string> {
  return profile === "cli" ? resolveAntigravityCliVersion() : resolveAntigravityIdeVersion();
}

/** Build one request-start compatibility context without exposing credential material. */
export function getAntigravityClientContext(
  provider: string,
  credentials: ProviderCredentials | null | undefined,
  observedVersion?: string | null
): AntigravityClientContext {
  const providerSpecificData = credentials?.providerSpecificData;
  if (observedVersion === undefined && providerSpecificData) {
    const storedProfile = providerSpecificData.clientProfile;
    const storedContractId = providerSpecificData.clientContractId;
    const storedObservedVersion = providerSpecificData.clientObservedVersion;
    const storedVersionState = providerSpecificData.clientVersionState;
    const storedSource = providerSpecificData.clientContextSource;
    if (
      typeof storedProfile === "string" &&
      typeof storedContractId === "string" &&
      (storedObservedVersion === null || typeof storedObservedVersion === "string") &&
      typeof storedVersionState === "string" &&
      typeof storedSource === "string"
    ) {
      const storedContext = {
        profile: readPersistedContextProfile(storedProfile),
        contractId: storedContractId,
        observedVersion: storedObservedVersion,
        versionState: storedVersionState,
        source: storedSource,
      } as AntigravityClientContext;
      assertAntigravityClientContextCompatible(storedContext);
      return storedContext;
    }
  }
  const hasPersistedProfile =
    providerSpecificData && typeof providerSpecificData.clientProfile === "string";
  if (observedVersion === undefined && hasPersistedProfile) {
    const profile = getAntigravityClientProfile(credentials);
    return createAntigravityClientContext(
      provider,
      credentials,
      profile === "cli" ? ANTIGRAVITY_CLI_FALLBACK_VERSION : ANTIGRAVITY_IDE_FALLBACK_VERSION
    );
  }
  return createAntigravityClientContext(provider, credentials, observedVersion);
}

export function removeHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
}

function getProjectHeaderValue(body: unknown): string | null {
  const project =
    body && typeof body === "object" ? (body as Record<string, unknown>).project : null;
  if (typeof project !== "string" || project.trim().length === 0) return null;
  if (project === "test-project" || project === "project-id") return null;
  return project;
}

/** Apply the selected official client identity to a Cloud Code content request. */
export function getAntigravityClientContextMetadata(
  context: AntigravityClientContext
): Record<string, string | null> {
  return {
    clientProfile: context.profile,
    clientContractId: context.contractId,
    clientObservedVersion: context.observedVersion,
    clientVersionState: context.versionState,
    clientContextSource: context.source,
  };
}

export function applyAntigravityClientProfileHeaders(
  headers: Record<string, string>,
  credentials: AntigravityProfileCredentials | null | undefined,
  body: unknown,
  context?: AntigravityClientContext
): AntigravityClientContext {
  const profile = getAntigravityClientProfile(credentials);
  const resolvedContext =
    context ??
    createAntigravityClientContext(
      profile === "cli" ? "agy" : "antigravity",
      credentials as ProviderCredentials | null | undefined
    );
  assertAntigravityClientContextCompatible(resolvedContext);
  if (resolvedContext.profile !== profile && credentials?.providerSpecificData?.clientProfile) {
    throw new Error("Antigravity client context profile does not match credentials");
  }
  const identityHeaders = context
    ? getAntigravityContentHeaders(
        { accessToken: credentials?.accessToken ?? undefined },
        resolvedContext
      )
    : getAntigravityContentHeaders(profile, credentials?.accessToken ?? undefined);

  removeHeaderCaseInsensitive(headers, "User-Agent");
  headers["User-Agent"] = identityHeaders["User-Agent"];
  for (const name of ABSENT_CONTENT_IDENTITY_HEADERS) {
    removeHeaderCaseInsensitive(headers, name);
  }

  const project = getProjectHeaderValue(body);
  removeHeaderCaseInsensitive(headers, "x-goog-user-project");
  if (project) {
    headers["x-goog-user-project"] = project;
  }

  return resolvedContext;
}
