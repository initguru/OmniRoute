/**
 * usage/gemini-web.ts — Gemini Web Usage Provider
 *
 * Exposes getGeminiWebUsage which delegates to fetchGeminiWebQuota
 * and formats the result into the standard UsageQuota structure.
 */

import { type UsageQuota } from "./quota.ts";
import { fetchGeminiWebQuota } from "../geminiWebQuotaFetcher.ts";

export type GeminiWebUsageResult = {
  plan?: string;
  quotas?: Record<string, UsageQuota>;
  message?: string;
};

/**
 * Retrieves Gemini Web quota and formats it as standard usage data.
 */
export async function getGeminiWebUsage(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<GeminiWebUsageResult> {
  const quotaInfo = await fetchGeminiWebQuota(connectionId, connection);
  if (!quotaInfo) {
    return { message: "Failed to fetch Gemini Web quota" };
  }

  const remaining = Math.max(0, quotaInfo.total - quotaInfo.used);
  const remainingPercentage = quotaInfo.total > 0 ? (remaining / quotaInfo.total) * 100 : 0;

  const quota: UsageQuota = {
    used: quotaInfo.used,
    total: quotaInfo.total,
    remaining,
    remainingPercentage,
    resetAt: quotaInfo.resetAt ?? null,
    unlimited: false,
    displayName: "Deep Think",
  };

  return {
    plan: "Free",
    quotas: {
      "gemini-deep-think": quota,
    },
  };
}
