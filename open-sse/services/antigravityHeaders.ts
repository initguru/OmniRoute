import type { ProviderCredentials } from "../executors/base.ts";
import {
  assertAntigravityClientContextCompatible,
  createAntigravityClientContext,
  type AntigravityClientContext,
} from "../config/antigravityClient.ts";
import type { AntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";
import {
  ANTIGRAVITY_CLI_FALLBACK_VERSION,
  ANTIGRAVITY_IDE_FALLBACK_VERSION,
  getCachedAntigravityCliVersion,
  getCachedAntigravityIdeVersion,
} from "./antigravityVersion.ts";

// loadCodeAssist/onboardUser's `metadata` body is a protobuf-JSON-shaped
// object — ideType/pluginType are int32 enums on the wire, not strings, and
// platform is required. Values mirror the sibling 9router project's
// LOAD_CODE_ASSIST_METADATA (open-sse/config/appConstants.js).
const ANTIGRAVITY_IDE_TYPE_ENUM = 9;
const ANTIGRAVITY_PLUGIN_TYPE_GEMINI_ENUM = 2;
const ANTIGRAVITY_PLATFORM_ENUM = {
  UNSPECIFIED: 0,
  DARWIN_AMD64: 1,
  DARWIN_ARM64: 2,
  LINUX_AMD64: 3,
  LINUX_ARM64: 4,
  WINDOWS_AMD64: 5,
} as const;

function resolveAntigravityPlatformEnum(): number {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    return arch === "arm64"
      ? ANTIGRAVITY_PLATFORM_ENUM.DARWIN_ARM64
      : ANTIGRAVITY_PLATFORM_ENUM.DARWIN_AMD64;
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? ANTIGRAVITY_PLATFORM_ENUM.LINUX_ARM64
      : ANTIGRAVITY_PLATFORM_ENUM.LINUX_AMD64;
  }
  if (platform === "win32") return ANTIGRAVITY_PLATFORM_ENUM.WINDOWS_AMD64;
  return ANTIGRAVITY_PLATFORM_ENUM.UNSPECIFIED;
}

export const ANTIGRAVITY_IDE_NODE_API_CLIENT = "google-api-nodejs-client/10.3.0";
export const ANTIGRAVITY_IDE_NODE_X_GOOG_API_CLIENT = "gl-node/22.21.1";

// Antigravity presents the native macOS desktop client fingerprint. The OS/arch
// token is intentionally independent from the host running OmniRoute.
const ANTIGRAVITY_OS_TYPE = "darwin";
const ANTIGRAVITY_ARCH = "arm64";

type AntigravityHeaderCredentials = Pick<ProviderCredentials, "accessToken"> & {
  providerSpecificData?: Record<string, unknown> | null;
};

type AntigravityHeaderContext = AntigravityClientContext | undefined;

function withOptionalBearerAuth(
  headers: Record<string, string>,
  accessToken?: string | null
): Record<string, string> {
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

function isAntigravityClientContext(value: unknown): value is AntigravityClientContext {
  return Boolean(
    value &&
    typeof value === "object" &&
    "profile" in value &&
    "contractId" in value &&
    "versionState" in value
  );
}

function createDefaultContext(profile: AntigravityClientProfile): AntigravityClientContext {
  return createAntigravityClientContext(profile === "cli" ? "agy" : "antigravity", undefined);
}

export function resolveAntigravityClientProfile(value: unknown): AntigravityClientProfile {
  if (value === undefined || value === null) return "ide";
  if (typeof value !== "string") {
    throw new Error("Antigravity compatibility contract rejected profile");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "harness" || normalized === "sdk") return "cli";
  if (normalized === "cli" || normalized === "ide") return normalized;
  throw new Error("Antigravity compatibility contract rejected profile");
}

function resolveHeaderContext(
  credentialsOrProfile: AntigravityHeaderCredentials | AntigravityClientProfile,
  context?: AntigravityHeaderContext
): AntigravityClientContext {
  if (context) {
    assertAntigravityClientContextCompatible(context);
    return context;
  }
  if (typeof credentialsOrProfile === "string") {
    return createDefaultContext(credentialsOrProfile);
  }
  const profile = resolveAntigravityClientProfile(
    credentialsOrProfile.providerSpecificData?.clientProfile
  );
  return createDefaultContext(profile);
}

function resolveAccessToken(
  credentialsOrProfile: AntigravityHeaderCredentials | AntigravityClientProfile,
  accessTokenOrContext?: string | null | AntigravityClientContext
): string | null | undefined {
  if (typeof credentialsOrProfile === "string") {
    return typeof accessTokenOrContext === "string" ? accessTokenOrContext : undefined;
  }
  return credentialsOrProfile.accessToken;
}

function getContextFallbackVersion(context: AntigravityClientContext): string {
  return context.profile === "cli"
    ? ANTIGRAVITY_CLI_FALLBACK_VERSION
    : ANTIGRAVITY_IDE_FALLBACK_VERSION;
}

function resolveContextVersion(context: AntigravityClientContext): string | undefined {
  return context.observedVersion || getContextFallbackVersion(context);
}

export function antigravityIdeUserAgent(version = getCachedAntigravityIdeVersion()): string {
  return `antigravity/ide/${version} ${ANTIGRAVITY_OS_TYPE}/${ANTIGRAVITY_ARCH}`;
}

export function antigravityCliUserAgent(
  version = getCachedAntigravityCliVersion(),
  authMethod = "consumer"
): string {
  return `antigravity/cli/${version} (aidev_client; os_type=${ANTIGRAVITY_OS_TYPE}; arch=${ANTIGRAVITY_ARCH}; auth_method=${authMethod})`;
}

export function antigravityIdeNodeUserAgent(version = getCachedAntigravityIdeVersion()): string {
  return `antigravity/${version} ${ANTIGRAVITY_OS_TYPE}/${ANTIGRAVITY_ARCH} ${ANTIGRAVITY_IDE_NODE_API_CLIENT}`;
}

export function getAntigravityOAuthUserAgent(
  profileOrContext: AntigravityClientProfile | AntigravityClientContext,
  observedVersion?: string | null
): string {
  const profile =
    typeof profileOrContext === "string" ? profileOrContext : profileOrContext.profile;
  const version =
    typeof profileOrContext === "string"
      ? observedVersion || undefined
      : resolveContextVersion(profileOrContext);
  return profile === "cli"
    ? antigravityCliUserAgent(version || getCachedAntigravityCliVersion())
    : antigravityIdeNodeUserAgent(version || getCachedAntigravityIdeVersion());
}

export function getAntigravityContentHeaders(
  profile: AntigravityClientProfile,
  accessToken?: string | null
): Record<string, string>;
export function getAntigravityContentHeaders(
  credentials: AntigravityHeaderCredentials,
  context?: AntigravityClientContext
): Record<string, string>;
export function getAntigravityContentHeaders(
  credentialsOrProfile: AntigravityHeaderCredentials | AntigravityClientProfile,
  accessTokenOrContext?: string | null | AntigravityClientContext
): Record<string, string> {
  const suppliedContext = isAntigravityClientContext(accessTokenOrContext)
    ? accessTokenOrContext
    : undefined;
  const context = resolveHeaderContext(credentialsOrProfile, suppliedContext);
  const accessToken = resolveAccessToken(credentialsOrProfile, accessTokenOrContext);
  const version = suppliedContext ? resolveContextVersion(context) : undefined;
  return withOptionalBearerAuth(
    {
      "Content-Type": "application/json",
      "User-Agent":
        context.profile === "cli"
          ? antigravityCliUserAgent(version || getCachedAntigravityCliVersion())
          : antigravityIdeUserAgent(version || getCachedAntigravityIdeVersion()),
    },
    accessToken
  );
}

export function getAntigravityBootstrapHeaders(
  credentials: AntigravityHeaderCredentials,
  context?: AntigravityClientContext
): Record<string, string> {
  return getAntigravityContentHeaders(credentials, context);
}

export function getAntigravityIdeNodeHeaders(
  accessToken?: string | null,
  context?: AntigravityClientContext
): Record<string, string> {
  const resolvedContext = context
    ? (assertAntigravityClientContextCompatible(context), context)
    : createDefaultContext("ide");
  const version = resolveContextVersion(resolvedContext) || getCachedAntigravityIdeVersion();
  return withOptionalBearerAuth(
    {
      "Content-Type": "application/json",
      "User-Agent": antigravityIdeNodeUserAgent(version),
      "X-Goog-Api-Client": ANTIGRAVITY_IDE_NODE_X_GOOG_API_CLIENT,
    },
    accessToken
  );
}

/** Native loadCodeAssist body metadata captured from both official clients. */
export function getAntigravityLoadCodeAssistMetadata(
  _context?: AntigravityClientContext
): Record<string, number> {
  return {
    ideType: ANTIGRAVITY_IDE_TYPE_ENUM,
    platform: resolveAntigravityPlatformEnum(),
    pluginType: ANTIGRAVITY_PLUGIN_TYPE_GEMINI_ENUM,
  };
}
