/**
 * usage/zcode.ts — ZCode (Z.ai Coding Plan) usage fetcher.
 *
 * Reads encrypted credentials and telemetry state from the local ZCode Desktop app
 * profile (~/.zcode/v2/credentials.json, telemetry-state.json), decrypts the active
 * desktop JWT session token (AES-256-GCM), and calls the ZCode billing/balance API
 * to retrieve real-time token quotas for Start Plan (GLM-5.3, GLM-5.3-Flash) and paid plans.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createDecipheriv, createHash, randomUUID } from "crypto";
import type { UsageQuota } from "./quota.ts";

const ENC_PREFIX = "enc:v1:";
const CIPHER_ALGO = "aes-256-gcm";
const FALLBACK_SECRET_PREFIX = "zcode-credential-fallback:";
const BALANCE_API_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.11.2";
const APP_VERSION = "3.11.2";

function deriveFallbackSecret(env = process.env): Buffer {
  const explicit = env["ZCODE_CREDENTIAL_SECRET"];
  if (explicit) {
    return createHash("sha256").update(explicit).digest();
  }

  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    // ignore
  }

  const raw = `${FALLBACK_SECRET_PREFIX}${os.platform()}:${os.homedir()}:${username}`;
  return createHash("sha256").update(raw).digest();
}

function base64UrlToBuffer(b64url: string): Buffer {
  return Buffer.from(b64url, "base64url");
}

export function decryptZCodeCredential(ciphertext: string, env = process.env): string {
  if (!ciphertext || typeof ciphertext !== "string" || !ciphertext.startsWith(ENC_PREFIX)) {
    return ciphertext;
  }

  const parts = ciphertext.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3) {
    return ciphertext;
  }

  const [ivB64, tagB64, dataB64] = parts;
  const iv = base64UrlToBuffer(ivB64);
  const tag = base64UrlToBuffer(tagB64);
  const data = base64UrlToBuffer(dataB64);

  const key = deriveFallbackSecret(env);
  const decipher = createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

function getZCodeProfilePath(subPath: string): string {
  return path.join(os.homedir(), ".zcode", "v2", subPath);
}

function resolveDeviceMid(): string {
  try {
    const telPath = getZCodeProfilePath("telemetry-state.json");
    if (fs.existsSync(telPath)) {
      const tel = JSON.parse(fs.readFileSync(telPath, "utf8"));
      if (tel?.deviceMid && typeof tel.deviceMid === "string") {
        return tel.deviceMid;
      }
    }
  } catch {
    // fallback below
  }
  return randomUUID();
}

function getPlatformString(): string {
  const plat = os.platform();
  const arch = os.arch();
  if (plat === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (plat === "win32") return arch === "arm64" ? "win32-arm64" : "win32-x64";
  return arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function getOsCategory(): string {
  const plat = os.platform();
  if (plat === "darwin") return "macos";
  if (plat === "win32") return "windows";
  return "linux";
}

export interface ZCodeUsageResult {
  plan?: string | null;
  quotas?: Record<string, UsageQuota> | null;
  message?: string | null;
}

export async function getZCodeUsage(
  _connectionId?: string,
  _apiKey?: string,
  _providerSpecificData?: Record<string, unknown>
): Promise<ZCodeUsageResult> {
  const credsPath = getZCodeProfilePath("credentials.json");

  if (!fs.existsSync(credsPath)) {
    return {
      message:
        "ZCode Desktop credentials not found (~/.zcode/v2/credentials.json). Please log in to ZCode Desktop.",
    };
  }

  let zcodeJwt: string;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    const rawToken = creds["zcodejwttoken"] || creds["token"] || creds["apiKey"];
    if (!rawToken || typeof rawToken !== "string") {
      return { message: "No active ZCode session token found in credentials.json." };
    }
    zcodeJwt = decryptZCodeCredential(rawToken);
  } catch (err) {
    return { message: `Failed to decrypt ZCode credentials: ${(err as Error).message}` };
  }

  const deviceMid = resolveDeviceMid();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${zcodeJwt}`,
    "x-api-key": zcodeJwt,
    "User-Agent": `ZCode/${APP_VERSION}`,
    "X-ZCode-App-Version": APP_VERSION,
    "X-Title": "Z Code@electron",
    "X-Platform": getPlatformString(),
    "X-Release-Channel": "stable",
    "X-Client-Language": "ko-KR",
    "X-Client-Timezone": timezone,
    "X-Os-Category": getOsCategory(),
    "X-Device-Mid": deviceMid,
    "x-request-id": randomUUID(),
    "HTTP-Referer": "https://zcode.z.ai",
  };

  let res: Response;
  try {
    res = await fetch(BALANCE_API_URL, { headers });
  } catch (err) {
    return { message: `ZCode billing API network error: ${(err as Error).message}` };
  }

  if (!res.ok) {
    if (res.status === 401) {
      return { message: "ZCode session expired. Please re-login on ZCode Desktop." };
    }
    return { message: `ZCode billing API HTTP ${res.status}` };
  }

  interface ZCodeBalanceItem {
    entitlement_id?: string;
    show_name?: string;
    total_units?: number;
    used_units?: number;
    remaining_units?: number;
    expires_at?: number;
  }

  interface ZCodeBalanceResponse {
    code?: number;
    msg?: string;
    data?: {
      balances?: ZCodeBalanceItem[];
    };
  }

  let json: ZCodeBalanceResponse;
  try {
    json = (await res.json()) as ZCodeBalanceResponse;
  } catch {
    return { message: "Invalid JSON response from ZCode billing API." };
  }

  if (json.code !== 0 || !json.data) {
    return { message: json.msg || "Failed to fetch ZCode plan balance." };
  }

  const balances = Array.isArray(json.data.balances) ? json.data.balances : [];
  if (balances.length === 0) {
    return { message: "No active token balance buckets found in ZCode plan." };
  }

  const quotas: Record<string, UsageQuota> = {};

  for (const b of balances) {
    const rawName = String(b.show_name || b.entitlement_id || "quota");
    // Normalize to stable key: e.g. "GLM-5.3" -> "glm-5.3", "GLM-5.3-Flash" -> "glm-5.3-flash"
    const quotaKey = rawName.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");

    const total = Number(b.total_units) || 0;
    const used = Number(b.used_units) || 0;
    const remaining = Number(b.remaining_units ?? Math.max(0, total - used));
    const remainingPercentage = total > 0 ? Math.round((remaining / total) * 1000) / 10 : 100;
    const resetAt = b.expires_at ? new Date(Number(b.expires_at) * 1000).toISOString() : null;

    quotas[quotaKey] = {
      used,
      total,
      remaining,
      remainingPercentage,
      resetAt,
      displayName: b.show_name || rawName,
      unlimited: false,
    };
  }

  const plan = json.data?.plans?.[0]?.name || "ZCode Start Plan";

  return {
    plan,
    quotas,
  };
}
