import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ZCODE_MODELS } from "../config/providers/registry/zcode/index.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

const DEFAULT_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan";
const DEFAULT_PROVIDER_ID = "builtin:zai-start-plan";
const ZCODE_APP_VERSION = "3.11.2";
export const ZCODE_MODEL_ALLOWLIST = new Set(ZCODE_MODELS.map((model) => model.id));
export const DEFAULT_ZCODE_MODEL = ZCODE_MODELS[0]?.id || "glm-5.2";

export type ZcodeModelResolution = { ok: true; model: string } | { ok: false; error: string };

export function resolveZcodeModel(model: unknown): ZcodeModelResolution {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) return { ok: true, model: DEFAULT_ZCODE_MODEL };
  if (requested.startsWith("-")) {
    return {
      ok: false,
      error: `Invalid ZCode model \"${requested}\": model must not start with \"-\".`,
    };
  }
  const normalized = requested.startsWith("zcode/") ? requested.slice("zcode/".length) : requested;
  if (!ZCODE_MODEL_ALLOWLIST.has(normalized)) {
    return {
      ok: false,
      error: `Unknown ZCode model \"${requested}\". Supported models: ${[...ZCODE_MODEL_ALLOWLIST].join(", ")}.`,
    };
  }
  return { ok: true, model: normalized };
}

export interface ZcodeDirectAuth {
  apiKey: string;
  baseURL: string;
}

export interface ZcodeDirectAuthOptions {
  apiKey?: unknown;
  baseURL?: unknown;
  baseUrl?: unknown;
  configPath?: string;
  config?: unknown;
}

export interface ZcodeDirectHeaderParams {
  apiKey: string;
  verifyParam: string;
  region?: string;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  queryId?: string;
  isAnthropic?: boolean;
}

export interface ZcodeDirectBodyParams {
  model: string;
  messages: unknown[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  deviceId?: string;
  sessionId?: string;
  isAnthropic?: boolean;
  [key: string]: unknown;
}

export interface ZcodeDirectErrorClassification {
  isCaptchaError: boolean;
  isUnusualActivity: boolean;
  isAuthError: boolean;
  message: string;
  code?: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function resolveAuthValues(value: unknown): ZcodeDirectAuth | null {
  const root = asRecord(value);
  const provider = asRecord(root.provider?.[DEFAULT_PROVIDER_ID]);
  const options = asRecord(provider.options);
  const apiKey =
    nonEmptyString(root.apiKey) ??
    nonEmptyString(options.apiKey) ??
    nonEmptyString(provider.apiKey);
  if (!apiKey) return null;
  const baseURL =
    nonEmptyString(root.baseURL) ??
    nonEmptyString(root.baseUrl) ??
    nonEmptyString(options.baseURL) ??
    nonEmptyString(options.baseUrl) ??
    nonEmptyString(provider.baseURL) ??
    nonEmptyString(provider.baseUrl) ??
    DEFAULT_BASE_URL;
  return { apiKey, baseURL };
}

/** Resolve the API credential used by the ZCode desktop Start Plan client. */
export function resolveZcodeDirectAuth(customConfig?: unknown): ZcodeDirectAuth | null {
  if (customConfig !== undefined) {
    const explicit = resolveAuthValues(customConfig);
    if (explicit) return explicit;
    const options = asRecord(customConfig) as ZcodeDirectAuthOptions;
    if (options.config !== undefined) {
      const nested = resolveAuthValues(options.config);
      if (nested) return nested;
    }
    if (options.configPath) return resolveAuthValues(readJsonFile(options.configPath));
    return null;
  }

  const configPath = path.join(os.homedir(), ".zcode", "cli", "config.json");
  return resolveAuthValues(readJsonFile(configPath));
}

function stableFallbackDeviceId(): string {
  const digest = createHash("sha256").update(`zcode-device:${os.homedir()}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Resolve the stable device identity used in ZCode telemetry metadata. */
export function resolveZcodeDeviceId(): string {
  const telemetryPath = path.join(os.homedir(), ".zcode", "v2", "telemetry-state.json");
  const telemetry = asRecord(readJsonFile(telemetryPath));
  return nonEmptyString(telemetry.deviceMid) ?? stableFallbackDeviceId();
}

function compactUuid(): string {
  return randomUUID().replaceAll("-", "");
}

export function buildZcodeDirectHeaders(params: ZcodeDirectHeaderParams): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.apiKey}`,
    "x-api-key": params.apiKey,
    "x-aliyun-captcha-verify-param": params.verifyParam,
    "x-aliyun-captcha-verify-region": params.region || "sgp",
    "x-request-id": params.requestId || randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": params.traceId || randomUUID(),
    "x-session-id": params.sessionId || compactUuid(),
    "x-query-id": params.queryId || compactUuid(),
    "user-agent": `ZCode/${ZCODE_APP_VERSION}`,
    "x-zcode-app-version": ZCODE_APP_VERSION,
    "content-type": "application/json",
  };
  if (params.isAnthropic) headers["anthropic-version"] = "2023-06-01";
  return headers;
}

export function buildZcodeDirectBody(params: ZcodeDirectBodyParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!["isAnthropic", "deviceId", "sessionId"].includes(key) && value !== undefined) {
      body[key] = value;
    }
  }
  if (params.isAnthropic) {
    const existingMeta = asRecord(params.metadata);
    body.metadata = {
      ...existingMeta,
      user_id: JSON.stringify({
        device_id: params.deviceId || "",
        account_uuid: "",
        session_id: params.sessionId || "",
      }),
    };
  }
  return body;
}

function findErrorCode(value: unknown, visited = new Set<object>()): number | undefined {
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  const record = asRecord(value);
  for (const candidate of [record.code, record.error_code, record.providerCode]) {
    const numeric =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate)
          ? Number(candidate)
          : undefined;
    if (numeric === 3007 || numeric === 3012) return numeric;
  }
  for (const child of Object.values(record)) {
    const nested = findErrorCode(child, visited);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findErrorMessage(value: unknown, visited = new Set<object>()): string | undefined {
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  const record = asRecord(value);
  const direct = nonEmptyString(record.message) ?? nonEmptyString(record.msg);
  if (direct) return direct;
  for (const child of Object.values(record)) {
    const nested = findErrorMessage(child, visited);
    if (nested) return nested;
  }
  return undefined;
}

function standardErrorCode(status: number): number | undefined {
  return Number.isInteger(status) && status > 0 ? status : undefined;
}

export function classifyZcodeDirectError(
  status: number,
  data: unknown
): ZcodeDirectErrorClassification {
  const code = findErrorCode(data);
  const rawMessage = findErrorMessage(data) ?? `ZCode direct API request failed (${status})`;
  const message = sanitizeErrorMessage(rawMessage) || `ZCode direct API request failed (${status})`;
  const fallbackCode = standardErrorCode(status);
  return {
    isCaptchaError: code === 3007,
    isUnusualActivity: code === 3012,
    isAuthError: status === 401 || status === 403,
    message,
    ...(code === 3007 || code === 3012
      ? { code }
      : fallbackCode && status >= 400
        ? { code: fallbackCode }
        : {}),
  };
}

export { DEFAULT_BASE_URL };
