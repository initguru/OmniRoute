/**
 * Direct protocol helpers for Gemini Web (3.1 Pro / Deep Think).
 *
 * Implements direct HTTP StreamGenerate and batchexecute (hNvQHb) polling
 * to bypass Playwright DOM typing and long-polling UI state machine.
 */

import { randomUUID } from "node:crypto";
import { parseCookies, mergeRotatedGeminiCookies } from "./cookieUtils.ts";

export const GEMINI_DEEP_THINK_MODEL_ID = "797f3d0293f288ad";

export interface GeminiWebSessionTokens {
  atToken: string;
  fSid: string;
  buildLabel: string;
}

export interface GeminiWebSessionBootstrapResult extends GeminiWebSessionTokens {
  mergedCookie?: string;
}

export interface StreamGenerateOptions {
  contextToken?: string;
  sessionId?: string;
  atToken?: string;
}

export interface StreamGenerateEnvelopeResult {
  conversationId: string;
  responseId: string;
  isPending: boolean;
  initialText?: string;
  error?: string;
}

export interface PollResponseResult {
  isPending: boolean;
  isFailed: boolean;
  text?: string;
  thoughts?: string;
  error?: string;
}

export interface BootstrapSessionOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Builds HTTP headers required for Gemini Web StreamGenerate requests.
 */
export function buildModelHeaders(
  modelId: string = GEMINI_DEEP_THINK_MODEL_ID,
  clientUuid?: string
): Record<string, string> {
  const uuid = clientUuid ?? randomUUID().toUpperCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const nowNanos = (Date.now() % 1000) * 1_000_000;

  const ext525 = [
    1,
    null,
    null,
    null,
    modelId,
    null,
    null,
    0,
    [4, 5, 6, 8, 4, 5, 6, 8],
    null,
    null,
    3,
    null,
    null,
    3,
    3,
    uuid,
    null,
    null,
    [
      [5, 40300000],
      [nowSec, nowNanos],
    ],
  ];

  return {
    "x-goog-ext-525001261-jspb": JSON.stringify(ext525),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0,0,0]",
    "x-same-domain": "1",
  };
}

/**
 * Builds URLSearchParams body for the initial StreamGenerate POST request.
 */
export function buildStreamGenerateBody(
  prompt: string,
  options?: StreamGenerateOptions
): URLSearchParams {
  const inner: unknown[] = Array.from({ length: 99 }, () => null);

  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[3] = options?.contextToken ?? null;
  inner[4] = "5332ff0c5c851ad12a167845399b8da1";
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = options?.sessionId ?? randomUUID().toUpperCase();
  inner[61] = [];
  inner[67] = 0;
  inner[68] = 2;
  inner[79] = 3;
  inner[80] = 3;
  inner[91] = 0;
  inner[96] = 1;
  inner[98] = 1;

  const params = new URLSearchParams();
  params.set("f.req", JSON.stringify([null, JSON.stringify(inner)]));
  if (options?.atToken) {
    params.set("at", options.atToken);
  }

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
 * Recursively locates a candidate array within an envelope payload.
 * A candidate array has an 'rc_' ID at [0] and a status array at [8].
 */
function findCandidate(val: unknown): unknown[] | null {
  if (!Array.isArray(val)) return null;
  if (typeof val[0] === "string" && val[0].startsWith("rc_") && Array.isArray(val[8])) {
    return val;
  }
  for (const item of val) {
    const found = findCandidate(item);
    if (found) return found;
  }
  return null;
}

/**
 * Parses initial StreamGenerate envelope response to extract conversation ID and pending state.
 */
export function parseStreamGenerateEnvelope(responseText: string): StreamGenerateEnvelopeResult {
  const envelopes = parseGoogleEnvelopeLines(responseText);
  if (envelopes.length === 0) {
    return {
      conversationId: "",
      responseId: "",
      isPending: false,
      error: "Malformed or empty StreamGenerate response",
    };
  }

  let conversationId = "";
  let responseId = "";
  let isPending = false;
  let initialText: string | undefined;

  for (const envelope of envelopes) {
    for (const item of envelope) {
      if (Array.isArray(item) && item[0] === "wrb.fr" && typeof item[2] === "string") {
        try {
          const payload = JSON.parse(item[2]);
          if (Array.isArray(payload)) {
            const idTuple = payload[1];
            if (Array.isArray(idTuple) && typeof idTuple[0] === "string") {
              conversationId = idTuple[0];
              if (typeof idTuple[1] === "string") {
                responseId = idTuple[1];
              }
            }

            const cand = findCandidate(payload);
            if (cand) {
              const textPart = cand[1];
              if (Array.isArray(textPart)) {
                initialText = textPart.filter((p): p is string => typeof p === "string").join("");
              } else if (typeof textPart === "string") {
                initialText = textPart;
              }

              const statusTuple = cand[8];
              if (Array.isArray(statusTuple) && statusTuple[0] === 1) {
                isPending = true;
              }
            }
          }
        } catch {
          // Skip unparseable payload string
        }
      }
    }
  }

  if (!conversationId) {
    return {
      conversationId: "",
      responseId: "",
      isPending: false,
      error: "No conversationId found in StreamGenerate response",
    };
  }

  return {
    conversationId,
    responseId,
    isPending,
    initialText,
  };
}

/**
 * Builds URLSearchParams body for batchexecute polling RPC (hNvQHb).
 */
export function buildPollRequestBody(conversationId: string, atToken: string): URLSearchParams {
  const rpcArg = JSON.stringify([conversationId, 10, null, 1, [1], [4], null, 1]);
  const fReq = JSON.stringify([[["hNvQHb", rpcArg, null, "generic"]]]);

  const params = new URLSearchParams();
  params.set("f.req", fReq);
  params.set("at", atToken);

  return params;
}

/**
 * Parses batchexecute response from hNvQHb RPC.
 */
export function parsePollResponse(responseText: string): PollResponseResult {
  const envelopes = parseGoogleEnvelopeLines(responseText);
  if (envelopes.length === 0) {
    return {
      isPending: false,
      isFailed: true,
      error: "Malformed or empty poll response",
    };
  }

  for (const envelope of envelopes) {
    for (const item of envelope) {
      if (
        Array.isArray(item) &&
        item[0] === "wrb.fr" &&
        item[1] === "hNvQHb" &&
        typeof item[2] === "string"
      ) {
        try {
          const innerPayload = JSON.parse(item[2]);
          const cand = findCandidate(innerPayload);
          if (!cand) {
            continue;
          }

          const textParts = cand[1];
          let text: string | undefined;
          if (Array.isArray(textParts)) {
            text = textParts.filter((p): p is string => typeof p === "string").join("");
          } else if (typeof textParts === "string") {
            text = textParts;
          }

          let thoughts: string | undefined;
          const thoughtsBlock = cand[37];
          if (Array.isArray(thoughtsBlock) && thoughtsBlock.length > 0) {
            const firstThoughtEntry = thoughtsBlock[0];
            if (Array.isArray(firstThoughtEntry) && typeof firstThoughtEntry[0] === "string") {
              thoughts = firstThoughtEntry[0];
            } else if (typeof firstThoughtEntry === "string") {
              thoughts = firstThoughtEntry;
            }
          }

          const statusArr = cand[8];
          const statusCode = Array.isArray(statusArr) ? statusArr[0] : undefined;

          if (statusCode === 1) {
            return {
              isPending: true,
              isFailed: false,
              text,
              thoughts,
            };
          }

          const isFailureText =
            typeof text === "string" &&
            (text.includes("wasn't able to finish thinking") ||
              text.includes("ran into an issue") ||
              text.includes("I ran into an issue"));

          if (statusCode === 2 && !isFailureText) {
            return {
              isPending: false,
              isFailed: false,
              text,
              thoughts,
            };
          }

          return {
            isPending: false,
            isFailed: true,
            text,
            thoughts,
            error: isFailureText
              ? text
              : `Poll candidate finished with non-success status: ${statusCode ?? "unknown"}`,
          };
        } catch {
          // Payload parsing error, continue checking
        }
      }
    }
  }

  return {
    isPending: false,
    isFailed: true,
    error: "No valid hNvQHb RPC payload found in poll response",
  };
}

/**
 * Fetches https://gemini.google.com/app with session cookies and extracts required tokens.
 */
export function createCombinedSignal(signal?: AbortSignal, timeoutMs = 15000): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

export async function bootstrapGeminiWebSession(
  cookie: string,
  signal?: AbortSignal,
  options?: BootstrapSessionOptions
): Promise<GeminiWebSessionBootstrapResult> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 15000;
  const combinedSignal = createCombinedSignal(signal, timeoutMs);

  const res = await fetchFn("https://gemini.google.com/app", {
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: combinedSignal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Gemini Web session: HTTP ${res.status}`);
  }

  const responseUrl = res.url || "";
  const locationHeader = res.headers.get("location") || "";
  if (
    responseUrl.includes("accounts.google.com") ||
    responseUrl.includes("ServiceLogin") ||
    locationHeader.includes("accounts.google.com") ||
    locationHeader.includes("ServiceLogin")
  ) {
    throw new Error(
      "Failed to extract Gemini Web session tokens: redirected to login. Cookie may be expired or invalid."
    );
  }

  const html = await res.text();

  const atToken =
    html.match(/"SNlM0e":\s*"([^"]+)"/)?.[1] || html.match(/"SNlM0e",\s*"([^"]+)"/)?.[1];
  const fSid = html.match(/"FdrFJe":\s*"([^"]+)"/)?.[1] || html.match(/"FdrFJe",\s*"([^"]+)"/)?.[1];
  const buildLabel =
    html.match(/"cfb2h":\s*"([^"]+)"/)?.[1] || html.match(/"cfb2h",\s*"([^"]+)"/)?.[1];

  if (!atToken || !fSid || !buildLabel) {
    throw new Error(
      "Failed to extract Gemini Web session tokens (SNlM0e/FdrFJe/cfb2h). Cookie may be expired or invalid."
    );
  }

  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const setCookieHeaders =
    typeof getSetCookie === "function"
      ? getSetCookie.call(res.headers)
      : [res.headers.get("set-cookie")].filter((c): c is string => Boolean(c));

  let mergedCookie: string | undefined;
  if (setCookieHeaders.length > 0) {
    const jarCookies = setCookieHeaders.flatMap((header) => parseCookies(header));
    const merged = mergeRotatedGeminiCookies(cookie, jarCookies);
    if (merged && merged !== cookie) {
      mergedCookie = merged;
    }
  }

  return {
    atToken,
    fSid,
    buildLabel,
    ...(mergedCookie ? { mergedCookie } : {}),
  };
}
