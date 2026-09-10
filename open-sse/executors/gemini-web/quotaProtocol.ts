/**
 * Deep Think Quota RPC (qpEbW) Protocol for Gemini Web.
 *
 * Implements Google batchexecute RPC request construction and chunked response parsing
 * for Gemini Deep Think quota limits (total, remaining, used, percentUsed, resetAt).
 */

export const GEMINI_DEEP_THINK_QUOTA_RPC_ID = "qpEbW";
export const GEMINI_DEEP_THINK_QUOTA_ENDPOINT =
  "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=qpEbW";

export interface DeepThinkQuotaResult {
  total: number;
  remaining: number;
  used: number;
  percentUsed: number;
  resetAt: string | null;
}

/**
 * Builds URLSearchParams body for batchexecute qpEbW quota RPC.
 */
export function buildDeepThinkQuotaRequestBody(atToken: string): URLSearchParams {
  const fReq = JSON.stringify([
    [[GEMINI_DEEP_THINK_QUOTA_RPC_ID, "[[[1,4],[6,6],[1,15]]]", null, "generic"]],
  ]);

  const params = new URLSearchParams();
  params.set("f.req", fReq);
  params.set("at", atToken);

  return params;
}

/**
 * Parses Google chunked stream lines and extracts envelope items.
 */
function parseGoogleEnvelopeLines(rawText: string): unknown[][] {
  const envelopes: unknown[][] = [];
  const lines = rawText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith(")]}'") ||
      trimmed.startsWith(")]}") ||
      /^\d+$/.test(trimmed)
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        envelopes.push(parsed);
      }
    } catch {
      // Non-JSON line or partial chunk, skip
    }
  }

  return envelopes;
}

/**
 * Recursively extracts Google batchexecute envelope items starting with "wrb.fr".
 */
function findWrbFrItems(val: unknown): unknown[][] {
  const items: unknown[][] = [];
  if (Array.isArray(val)) {
    if (val[0] === "wrb.fr") {
      items.push(val);
    } else {
      for (const elem of val) {
        items.push(...findWrbFrItems(elem));
      }
    }
  }
  return items;
}

/**
 * Recursively locates the quota tuple array within an envelope payload.
 * Structure: [[null, 4], 2, status, [resetEpoch, ms], totalCap, remainingQuota]
 */
function findQuotaEntry(val: unknown): unknown[] | null {
  if (!Array.isArray(val)) {
    return null;
  }

  if (
    val.length >= 6 &&
    typeof val[4] === "number" &&
    typeof val[5] === "number" &&
    (val[3] === null || Array.isArray(val[3]) || typeof val[3] === "number")
  ) {
    return val;
  }

  for (const item of val) {
    const found = findQuotaEntry(item);
    if (found) return found;
  }

  return null;
}

/**
 * Calculates ISO reset timestamp from epoch and optional millisecond/microsecond offset.
 */
function calculateResetAt(resetEpoch: unknown, ms: unknown): string | null {
  if (typeof resetEpoch !== "number" || !Number.isFinite(resetEpoch) || resetEpoch <= 0) {
    return null;
  }

  const msOffset = typeof ms === "number" && Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  const timestampMs = resetEpoch < 1e12 ? resetEpoch * 1000 + msOffset : resetEpoch + msOffset;
  const date = new Date(timestampMs);

  if (isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

/**
 * Parses batchexecute response from qpEbW RPC.
 */
export function parseDeepThinkQuotaResponse(responseText: string): DeepThinkQuotaResult | null {
  if (!responseText || typeof responseText !== "string") {
    return null;
  }

  const envelopes = parseGoogleEnvelopeLines(responseText);
  if (envelopes.length === 0) {
    return null;
  }

  for (const envelope of envelopes) {
    const wrbFrItems = findWrbFrItems(envelope);
    for (const item of wrbFrItems) {
      if (item[1] === GEMINI_DEEP_THINK_QUOTA_RPC_ID && typeof item[2] === "string") {
        try {
          const innerPayload = JSON.parse(item[2]);
          const quotaEntry = findQuotaEntry(innerPayload);
          if (!quotaEntry) {
            continue;
          }

          const total = quotaEntry[4] as number;
          const remaining = quotaEntry[5] as number;
          const used = Math.max(0, total - remaining);
          const percentUsed = total > 0 ? used / total : 0;

          const resetField = quotaEntry[3];
          let resetEpoch: unknown;
          let ms: unknown;

          if (Array.isArray(resetField)) {
            resetEpoch = resetField[0];
            ms = resetField[1];
          } else if (typeof resetField === "number") {
            resetEpoch = resetField;
          }

          const resetAt = calculateResetAt(resetEpoch, ms);

          return {
            total,
            remaining,
            used,
            percentUsed,
            resetAt,
          };
        } catch {
          // Skip unparseable payload string
        }
      }
    }
  }

  return null;
}
