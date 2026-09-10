/**
 * geminiWebQuotaFetcher.ts — Gemini Web Deep Think Quota Fetcher
 *
 * Queries Google batchexecute RPC (qpEbW) to retrieve Deep Think quota limits,
 * remaining allowance, and reset timestamp for Gemini Web connections.
 */

import { registerQuotaFetcher, registerQuotaWindows, type QuotaInfo } from "./quotaPreflight.ts";
import { resolveGeminiWebCookie, resolveStaticSessionTokens } from "../executors/gemini-web.ts";
import { bootstrapGeminiWebSession } from "../executors/gemini-web/directProtocol.ts";
import {
  buildDeepThinkQuotaRequestBody,
  parseDeepThinkQuotaResponse,
} from "../executors/gemini-web/quotaProtocol.ts";

export const GEMINI_WEB_QUOTA_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  quota: QuotaInfo;
  fetchedAt: number;
}

const quotaCache = new Map<string, CacheEntry>();

const _cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of quotaCache) {
    if (now - entry.fetchedAt > GEMINI_WEB_QUOTA_CACHE_TTL_MS * 5) {
      quotaCache.delete(key);
    }
  }
}, 5 * 60_000);
if (typeof _cacheCleanup === "object" && _cacheCleanup && "unref" in _cacheCleanup) {
  (_cacheCleanup as { unref?: () => void }).unref?.();
}

export function clearGeminiWebQuotaCache(connectionId?: string): void {
  if (connectionId) {
    quotaCache.delete(connectionId);
  } else {
    quotaCache.clear();
  }
}

/**
 * Fetches Deep Think quota information for a Gemini Web connection.
 */
export async function fetchGeminiWebQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<QuotaInfo | null> {
  const cookie = resolveGeminiWebCookie(connection);
  if (!cookie) {
    return null;
  }

  const cached = quotaCache.get(connectionId);
  if (cached && Date.now() - cached.fetchedAt < GEMINI_WEB_QUOTA_CACHE_TTL_MS) {
    return cached.quota;
  }

  const connPsd =
    connection?.providerSpecificData &&
    typeof connection.providerSpecificData === "object" &&
    !Array.isArray(connection.providerSpecificData)
      ? (connection.providerSpecificData as Record<string, unknown>)
      : undefined;

  const credPsd = (
    connection?.credentials &&
    typeof connection.credentials === "object" &&
    !Array.isArray(connection.credentials) &&
    (connection.credentials as Record<string, unknown>).providerSpecificData &&
    typeof (connection.credentials as Record<string, unknown>).providerSpecificData === "object"
      ? (connection.credentials as Record<string, unknown>).providerSpecificData
      : undefined
  ) as Record<string, unknown> | undefined;

  let sessionTokens = resolveStaticSessionTokens(credPsd, connPsd);
  if (!sessionTokens) {
    try {
      sessionTokens = await bootstrapGeminiWebSession(cookie, undefined, { timeoutMs: 15000 });
    } catch {
      return null;
    }
  }

  if (!sessionTokens) {
    return null;
  }

  try {
    const { atToken, fSid, buildLabel } = sessionTokens;
    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const url = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=qpEbW&bl=${encodeURIComponent(buildLabel)}&f.sid=${encodeURIComponent(fSid)}&hl=en&_reqid=${reqId}&rt=c`;

    const body = buildDeepThinkQuotaRequestBody(atToken).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
        Cookie: cookie,
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      },
      body,
    });

    if (!response.ok) {
      return null;
    }

    const responseText = await response.text();
    const deepThinkResult = parseDeepThinkQuotaResponse(responseText);
    if (!deepThinkResult) {
      return null;
    }

    const quotaInfo: QuotaInfo = {
      used: deepThinkResult.used,
      total: deepThinkResult.total,
      percentUsed: deepThinkResult.percentUsed,
      resetAt: deepThinkResult.resetAt,
      windows: {
        "gemini-deep-think": {
          percentUsed: deepThinkResult.percentUsed,
          resetAt: deepThinkResult.resetAt,
        },
      },
      limitReached: deepThinkResult.remaining <= 0,
    };

    quotaCache.set(connectionId, {
      quota: quotaInfo,
      fetchedAt: Date.now(),
    });

    return quotaInfo;
  } catch {
    return null;
  }
}

/**
 * Registers the gemini-web quota fetcher and window mappings with quotaPreflight.
 */
export function registerGeminiWebQuotaFetcher(): void {
  registerQuotaFetcher("gemini-web", fetchGeminiWebQuota);
  registerQuotaFetcher("gweb", fetchGeminiWebQuota);
  registerQuotaWindows("gemini-web", ["gemini-deep-think"]);
  registerQuotaWindows("gweb", ["gemini-deep-think"]);
}
