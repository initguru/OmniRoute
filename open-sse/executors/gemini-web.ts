/**
 * GeminiWebExecutor — Gemini Web Session Provider
 *
 * Routes requests through Google Gemini's web interface using browser
 * cookies + Playwright automation. Translates between OpenAI chat
 * completions format and Gemini's web UI.
 *
 * Auth: Cookie-based (__Secure-1PSID + __Secure-1PSIDTS from gemini.google.com)
 * Method: Playwright browser automation
 *
 * Note: Streaming is pseudo-streaming — waits for full Gemini response then
 * sends as single SSE chunk. Gemini's StreamGenerate endpoint returns complete
 * responses, not chunked streams.
 */

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { normalizeGeminiCookieInput } from "../utils/geminiCookies.ts";
import { prepareToolMessages } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { purifyDeepThinkPrompt } from "./gemini-web/deepThinkPurifier.ts";
import {
  checkGeminiWebUnsupportedControls,
  GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
} from "./gemini-web/capabilities.ts";
import { resolveDeepThinkTimeoutMs } from "../handlers/chatCore/upstreamTimeouts.ts";
import { GEMINI_DEEP_THINK_TIMEOUT_CODE } from "../config/constants.ts";
import {
  GEMINI_DEEP_THINK_MODEL_ID,
  buildModelHeaders,
  buildStreamGenerateBody,
  parseStreamGenerateEnvelope,
  buildPollRequestBody,
  parsePollResponse,
  bootstrapGeminiWebSession,
  type GeminiWebSessionTokens,
} from "./gemini-web/directProtocol.ts";
import { parseCookies, mergeRotatedGeminiCookies } from "./gemini-web/cookieUtils.ts";
import { recoverGeminiWebSessionWithBrowser } from "./gemini-web/sessionRecovery.ts";

export { mergeRotatedGeminiCookies } from "./gemini-web/cookieUtils.ts";
export { recoverGeminiWebSessionWithBrowser } from "./gemini-web/sessionRecovery.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const GEMINI_URL = "https://gemini.google.com/app";
export const DEFAULT_GEMINI_WEB_BUILD_LABEL = "boq_assistant-bard-web-server_20260907.07_p0";

/**
 * Checks if model ID corresponds to Gemini Web Deep Think.
 */
export function isDeepThinkModel(modelId: string): boolean {
  return modelId === "gemini-deep-think" || modelId === GEMINI_DEEP_THINK_MODEL_ID;
}

/**
 * Whether an error came from Playwright failing to launch because the browser binary is not
 * installed (`chromium.launch: Executable doesn't exist at ...`). This is a host/config
 * problem, not a transient upstream fault, so the executor must NOT surface it as a retryable
 * 500 (which marks the account unavailable and loops / trips the provider breaker). See #3516.
 */
export function isMissingBrowserExecutable(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("executable doesn't exist") ||
    lower.includes("executablenotfound") ||
    lower.includes("playwright install") ||
    (lower.includes("chromium") && lower.includes("download"))
  );
}
const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ─── Direct API Session Cache ───────────────────────────────────────────────

interface CachedGeminiWebSession {
  tokens: GeminiWebSessionTokens;
  expiresAt: number;
}

const sessionCache = new Map<string, CachedGeminiWebSession>();
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedSession(cookie: string): GeminiWebSessionTokens | null {
  const cached = sessionCache.get(cookie);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tokens;
  }
  if (cached) {
    sessionCache.delete(cookie);
  }
  return null;
}

function setCachedSession(cookie: string, tokens: GeminiWebSessionTokens): void {
  if (sessionCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of sessionCache.entries()) {
      if (value.expiresAt <= now) {
        sessionCache.delete(key);
      }
    }
    if (sessionCache.size > 100) {
      const oldestKey = sessionCache.keys().next().value;
      if (oldestKey) sessionCache.delete(oldestKey);
    }
  }
  sessionCache.set(cookie, {
    tokens,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

function clearCachedSession(cookie: string): void {
  sessionCache.delete(cookie);
}

export function clearGeminiWebSessionCache(): void {
  sessionCache.clear();
}

export function resolveStaticSessionTokens(
  credentialsPsd?: Record<string, unknown> | null,
  connectionPsd?: Record<string, unknown> | null
): GeminiWebSessionTokens | null {
  const rawAt =
    credentialsPsd?.atToken ?? credentialsPsd?.at ?? connectionPsd?.atToken ?? connectionPsd?.at;
  const rawFsid =
    credentialsPsd?.fSid ?? credentialsPsd?.fsid ?? connectionPsd?.fSid ?? connectionPsd?.fsid;
  const rawBl =
    credentialsPsd?.buildLabel ??
    credentialsPsd?.bl ??
    connectionPsd?.buildLabel ??
    connectionPsd?.bl;

  const atToken = typeof rawAt === "string" && rawAt.trim().length > 0 ? rawAt.trim() : null;
  const fSid = typeof rawFsid === "string" && rawFsid.trim().length > 0 ? rawFsid.trim() : null;

  if (atToken && fSid) {
    const buildLabel =
      typeof rawBl === "string" && rawBl.trim().length > 0
        ? rawBl.trim()
        : DEFAULT_GEMINI_WEB_BUILD_LABEL;
    return { atToken, fSid, buildLabel };
  }

  return null;
}

function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Request aborted")
    );
  }
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Request aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface GeminiMessage {
  role: string;
  content: string;
}

interface GeminiRequestBody {
  messages: GeminiMessage[];
  model?: string;
  stream?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatChatCompletion(content: string, model: string, finishReason = "stop") {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function formatStreamChunk(content: string, model: string, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        textParts.push((part as { text: string }).text);
      }
    }
    return textParts.join("");
  }
  return "";
}

/**
 * Flatten the OpenAI-style multi-turn `messages[]` into the single plain-text
 * prompt typed into the Gemini web UI (#8371).
 *
 * gemini-web drives a real browser page and captures only the FIRST
 * `StreamGenerate` response, so — unlike claude-web — it has no upstream
 * conversation id to thread across turns. It is therefore a stateless,
 * single-turn provider: the previous code forwarded only the last user message
 * (`messages.filter(m => m.role === "user").pop()`), so follow-up questions
 * lost all prior context ("I am in Berlin" → "What should I wear today?" was
 * answered without Berlin). This implements the issue's accepted fallback (b):
 * flatten the full history into one prompt so the web UI still sees the
 * conversation.
 *
 * Single-turn requests are preserved byte-for-byte (only the final user message
 * is returned) — the regression guard for the pre-existing no-tools path.
 * Multi-turn requests emit a labeled transcript:
 *
 *   System:
 *   <system text>
 *
 *   Previous conversation:
 *   User: ...
 *   Assistant: ...
 *
 *   Current user message:
 *   <last user message>
 */
export function buildGeminiPrompt(messages: Array<{ role: string; content: unknown }>): string {
  const textMessages = messages
    .map((m) => ({
      role: m.role,
      content: extractMessageText(m.content),
    }))
    .filter((m) => m.content.trim().length > 0);

  const userMessages = textMessages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  const lastUserContent = lastUser?.content ?? "";
  const lastUserIdx = lastUser ? textMessages.lastIndexOf(lastUser) : -1;

  // Prior conversation = every user/assistant turn before the final user turn.
  const priorTurns = textMessages.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant")
  );

  // Single-turn (no earlier user/assistant turns): byte-for-byte the original
  // single-message derivation. Do NOT prepend system text here — the old
  // no-tools path ignored a system-only prefix on the first turn.
  if (priorTurns.length === 0) return lastUserContent;

  const systemText = textMessages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const historyLines = priorTurns.map(
    (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`
  );

  const parts: string[] = [];
  if (systemText) parts.push(`System:\n${systemText}`);
  parts.push(`Previous conversation:\n${historyLines.join("\n\n")}`);
  parts.push(`Current user message:\n${lastUserContent}`);
  return parts.join("\n\n");
}

/**
 * Build the plain-text prompt typed into the Gemini web UI when a tool
 * contract is active — the synthetic system message injected by
 * `prepareToolMessages()` prepended to the last user message. gemini-web
 * only ever sends a single flat string (no native message array), so the
 * tool contract and the user's ask are concatenated (#7286).
 */
export function buildGeminiToolPrompt(
  effectiveMessages: Array<{ role: string; content: unknown }>
): string {
  const toolSystemMsg = effectiveMessages.find((m) => m.role === "system");
  const lastUserMsg = [...effectiveMessages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg ? extractMessageText(lastUserMsg.content) : "";
  const toolPrompt = toolSystemMsg ? extractMessageText(toolSystemMsg.content) : "";
  return toolPrompt ? `${toolPrompt}\n\n${userText}` : userText;
}

/**
 * Tool mode: wrap the buffered Gemini response text in the standard OpenAI
 * completion shape, then delegate to the shared `buildToolModeResponse()`
 * (`chatgptWebTools.ts`) — parses `<tool>{...}</tool>` blocks out of the
 * text into `tool_calls` (malformed JSON degrades to ordinary `content`,
 * never throws) and replays either buffered JSON or a terminal SSE chunk
 * depending on `stream` (#7286). Exported standalone so the branching logic
 * is testable without a full Playwright mock.
 */
export async function buildGeminiToolResponse(
  responseText: string,
  requestedTools: unknown,
  stream: boolean,
  model: string,
  cid: string,
  created: number
): Promise<Response> {
  const bufferedJson = new Response(JSON.stringify(formatChatCompletion(responseText, model)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  return buildToolModeResponse(bufferedJson, requestedTools, stream, {
    cid,
    created,
    model,
    idSeed: "gwe",
  });
}

/**
 * Parse Gemini StreamGenerate response text.
 *
 * Response format:
 *   )]}'
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *   <length>
 *   [["wrb.fr", null, "<JSON string>"]]
 *
 * The JSON string contains nested array: inner[4][0][1] = ["text chunks"].
 * Each wrb.fr line is a CUMULATIVE snapshot of the whole answer generated so
 * far (not an independent delta), so we keep only the text from the LAST
 * frame that yields non-empty text instead of concatenating every frame —
 * concatenating would reproduce the same growing text with each snapshot
 * (see #7163).
 */
export function parseStreamResponse(raw: string): string {
  const lines = raw.split("\n");
  let lastText = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === ")]}'" || /^\d+$/.test(line)) continue;
    if (!line.includes("wrb.fr")) continue;
    try {
      const arr = JSON.parse(line);
      if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0][0] !== "wrb.fr") continue;
      const payload = arr[0]?.[2];
      if (typeof payload !== "string") continue;
      const inner = JSON.parse(payload);
      // Defensive: check each level before accessing
      const responseArray =
        inner?.[4]?.[0]?.[1] ?? inner?.[0]?.[4]?.[4] ?? inner?.[0]?.[4]?.[0]?.[1];
      if (!Array.isArray(responseArray)) continue;
      const text = responseArray.filter((c: unknown) => typeof c === "string").join("");
      if (text) lastText = text;
    } catch {
      // Skip unparseable lines
    }
  }
  return lastText;
}

function readCredentialString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readProviderSpecificString(
  providerSpecificData: unknown,
  keys: readonly string[]
): string {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  ) {
    return "";
  }
  const data = providerSpecificData as Record<string, unknown>;
  for (const key of keys) {
    const value = readCredentialString(data[key]);
    if (value) return value;
  }
  return "";
}

export function resolveGeminiWebCookie(
  credentials?: ExecuteInput["credentials"] | Record<string, unknown> | null
): string {
  const creds = (credentials ?? {}) as Record<string, unknown>;
  const nestedCreds =
    creds.credentials && typeof creds.credentials === "object" && !Array.isArray(creds.credentials)
      ? (creds.credentials as Record<string, unknown>)
      : undefined;

  const directCookie =
    readCredentialString(creds.apiKey) ||
    readCredentialString(creds.cookie) ||
    readCredentialString(nestedCreds?.apiKey) ||
    readCredentialString(nestedCreds?.cookie);
  if (directCookie) return normalizeGeminiCookieInput(directCookie);

  const providerSpecificData = creds.providerSpecificData ?? nestedCreds?.providerSpecificData;
  const cookie = readProviderSpecificString(providerSpecificData, ["cookie"]);
  if (cookie) return normalizeGeminiCookieInput(cookie);

  const psid = readProviderSpecificString(providerSpecificData, ["__Secure-1PSID"]);
  const psidts = readProviderSpecificString(providerSpecificData, ["__Secure-1PSIDTS"]);
  return [
    psid ? normalizeGeminiCookieInput(psid, "__Secure-1PSID") : "",
    psidts ? normalizeGeminiCookieInput(psidts, "__Secure-1PSIDTS") : "",
  ]
    .filter(Boolean)
    .join("; ");
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_URL });
  }

  /**
   * testConnection — validates the cookie format without making a network call
   * or launching Playwright. Returns true when the cookie is non-empty and
   * contains at least one name=value pair with a non-empty value. This is a
   * lightweight pre-check before the browser automation path; full session
   * validation is done by validateGeminiWebProvider in the connection test
   * flow (#9407).
   */
  async testConnection(
    credentials: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const cookie = resolveGeminiWebCookie(credentials as unknown as ExecuteInput["credentials"]);
      if (!cookie) return false;
      const pairs = parseCookies(cookie);
      return pairs.some((p) => p.value.length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Read the live Playwright cookie jar back after a successful run and, if
   * Google rotated any of the __Secure-1PSID* cookies, forward the merged
   * cookie string through onCredentialsRefreshed so it gets persisted to the
   * encrypted provider_connections.api_key field. Mirrors the rotate-and-
   * persist pattern used by other rotating-session executors. A persistence failure
   * must never fail the user-facing response (#7676).
   */
  private async persistRotatedCookies(
    context: import("playwright").BrowserContext,
    cookie: string,
    credentials: ExecuteInput["credentials"],
    onCredentialsRefreshed: ExecuteInput["onCredentialsRefreshed"],
    log: ExecuteInput["log"]
  ): Promise<void> {
    if (!onCredentialsRefreshed) return;
    try {
      const jarCookies = await context.cookies();
      const mergedCookie = mergeRotatedGeminiCookies(cookie, jarCookies);
      if (mergedCookie && mergedCookie !== cookie) {
        await onCredentialsRefreshed({ ...credentials, apiKey: mergedCookie });
      }
    } catch (err) {
      log?.warn?.(
        "GEMINI-WEB",
        `Failed to persist rotated cookie: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async persistRotatedCookiesFromHeaders(
    headers: Headers,
    cookie: string,
    credentials: ExecuteInput["credentials"],
    onCredentialsRefreshed: ExecuteInput["onCredentialsRefreshed"],
    log: ExecuteInput["log"]
  ): Promise<void> {
    if (!onCredentialsRefreshed) return;
    try {
      const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
      const setCookies =
        typeof getSetCookie === "function"
          ? getSetCookie.call(headers)
          : ([headers.get("set-cookie")].filter(Boolean) as string[]);
      if (setCookies.length === 0) return;

      const jarCookies = setCookies.flatMap((header: string) => parseCookies(header));
      const mergedCookie = mergeRotatedGeminiCookies(cookie, jarCookies);
      if (mergedCookie && mergedCookie !== cookie) {
        await onCredentialsRefreshed({ ...credentials, apiKey: mergedCookie });
      }
    } catch (err) {
      log?.warn?.(
        "GEMINI-WEB",
        `Failed to persist rotated cookie from headers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async buildFormattedResponse(params: {
    responseText: string;
    modelId: string;
    hasTools: boolean;
    requestedTools: unknown;
    stream: boolean;
    body: unknown;
  }) {
    const { responseText, modelId, hasTools, requestedTools, stream, body } = params;

    if (hasTools) {
      const cid = `chatcmpl-gwe-${crypto.randomUUID().slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);
      const toolResponse = await buildGeminiToolResponse(
        responseText,
        requestedTools,
        stream,
        modelId,
        cid,
        created
      );
      return { response: toolResponse, url: GEMINI_URL, headers: {}, transformedBody: body };
    }

    if (stream) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream(
        {
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(formatStreamChunk(responseText, modelId))}\n\n`
              )
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}\n\n`)
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        },
        { highWaterMark: 16384 }
      );
      return {
        response: new Response(readable, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    return {
      response: new Response(JSON.stringify(formatChatCompletion(responseText, modelId)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url: GEMINI_URL,
      headers: {},
      transformedBody: body,
    };
  }

  private async executeDirectDeepThink(params: {
    input: ExecuteInput;
    cookie: string;
    prompt: string;
    modelId: string;
    hasTools: boolean;
    requestedTools: unknown;
  }) {
    let { cookie } = params;
    const { input, prompt, modelId, hasTools, requestedTools } = params;
    const { body, stream, credentials, signal, log, onCredentialsRefreshed } = input;
    const fetchFn = (input as { fetch?: typeof fetch }).fetch ?? fetch;

    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }

      const credPsd = credentials?.providerSpecificData as Record<string, unknown> | undefined;
      const connPsd = (
        input as unknown as { connection?: { providerSpecificData?: Record<string, unknown> } }
      )?.connection?.providerSpecificData;

      const timeoutMs = resolveDeepThinkTimeoutMs(
        (credPsd as { timeoutMs?: number } | undefined)?.timeoutMs ??
          (connPsd as { timeoutMs?: number } | undefined)?.timeoutMs
      );

      // 1. Session tokens: static from providerSpecificData, cached, or bootstrap
      let sessionTokens = resolveStaticSessionTokens(credPsd, connPsd);
      if (!sessionTokens) {
        sessionTokens = getCachedSession(cookie);
      }
      if (!sessionTokens) {
        try {
          const bootstrapResult = await bootstrapGeminiWebSession(cookie, signal ?? undefined, {
            fetchFn,
            timeoutMs: Math.min(timeoutMs, 15000),
          });
          sessionTokens = bootstrapResult;
          if (bootstrapResult.mergedCookie && bootstrapResult.mergedCookie !== cookie) {
            const oldCookie = cookie;
            cookie = bootstrapResult.mergedCookie;
            try {
              await onCredentialsRefreshed?.({
                ...credentials,
                apiKey: bootstrapResult.mergedCookie,
              });
            } catch (err) {
              log?.warn?.(
                "GEMINI-WEB",
                `Failed to persist rotated cookie from bootstrap: ${err instanceof Error ? err.message : String(err)}`
              );
            }
            setCachedSession(cookie, sessionTokens);
            setCachedSession(oldCookie, sessionTokens);
          } else {
            setCachedSession(cookie, sessionTokens);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.warn?.(
            "GEMINI-WEB",
            `Direct bootstrap failed: ${msg}. Attempting Tier 2 browser self-healing recovery...`
          );
          const recovery = await recoverGeminiWebSessionWithBrowser({
            cookie,
            credentials: credentials as Record<string, unknown> | undefined,
            onCredentialsRefreshed,
            log: log ?? undefined,
            signal: signal ?? undefined,
            timeoutMs: Math.min(timeoutMs, 25000),
            playwright: (input as { playwright?: unknown }).playwright,
          });
          if (recovery.success && recovery.tokens) {
            sessionTokens = recovery.tokens;
            if (recovery.mergedCookie && recovery.mergedCookie !== cookie) {
              const oldCookie = cookie;
              cookie = recovery.mergedCookie;
              setCachedSession(cookie, sessionTokens);
              setCachedSession(oldCookie, sessionTokens);
            } else {
              setCachedSession(cookie, sessionTokens);
            }
            log?.info?.(
              "GEMINI-WEB",
              "Tier 2 browser self-healing recovery succeeded; proceeding with Direct API request."
            );
          } else {
            log?.warn?.(
              "GEMINI-WEB",
              `Tier 2 browser self-healing recovery failed: ${recovery.error || "unknown"}`
            );
            return {
              response: new Response(
                JSON.stringify(
                  buildErrorBody(401, sanitizeErrorMessage(msg), null, {
                    type: "authentication_error",
                    code: "gemini_web_auth_required",
                  })
                ),
                {
                  status: 401,
                  headers: { "Content-Type": "application/json" },
                }
              ),
              url: GEMINI_URL,
              headers: {},
              transformedBody: body,
            };
          }
        }
      }

      const { atToken, fSid, buildLabel } = sessionTokens;

      // 2. StreamGenerate request
      const streamReqId = Math.floor(Math.random() * 900000) + 100000;
      const streamUrl = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(buildLabel)}&f.sid=${encodeURIComponent(fSid)}&hl=en&_reqid=${streamReqId}&rt=c`;

      const streamBodyParams = buildStreamGenerateBody(prompt, { atToken });
      const streamHeaders: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
        Cookie: cookie,
        ...buildModelHeaders(GEMINI_DEEP_THINK_MODEL_ID),
      };

      const streamResp = await fetchFn(streamUrl, {
        method: "POST",
        headers: streamHeaders,
        body: streamBodyParams.toString(),
        signal: signal ?? undefined,
      });

      if (!streamResp.ok) {
        clearCachedSession(cookie);
        const isAuthErr = streamResp.status === 401 || streamResp.status === 403;
        const status = isAuthErr ? 401 : streamResp.status >= 500 ? 502 : streamResp.status;
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(
                status,
                `Gemini StreamGenerate error: HTTP ${streamResp.status}`,
                null,
                {
                  type: isAuthErr ? "authentication_error" : "server_error",
                  code: isAuthErr ? "gemini_web_auth_required" : "upstream_error",
                }
              )
            ),
            { status, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      await this.persistRotatedCookiesFromHeaders(
        streamResp.headers,
        cookie,
        credentials,
        onCredentialsRefreshed,
        log
      );

      const rawStreamText = await streamResp.text();
      const envelope = parseStreamGenerateEnvelope(rawStreamText);

      if (envelope.error && !envelope.conversationId) {
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(502, envelope.error, null, {
                type: "server_error",
                code: "gemini_deep_think_generation_failed",
              })
            ),
            { status: 502, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      let finalResponseText = "";

      if (!envelope.isPending && envelope.initialText) {
        finalResponseText = envelope.initialText;
      } else if (Boolean(stream)) {
        // Early SSE Streaming with periodic keepalive pings during polling
        const conversationId = envelope.conversationId;
        const pollStartTime = Date.now();
        const pollIntervalMs =
          (credPsd as { pollIntervalMs?: number } | undefined)?.pollIntervalMs ??
          (connPsd as { pollIntervalMs?: number } | undefined)?.pollIntervalMs ??
          1500;
        const keepaliveIntervalMs =
          (credPsd as { keepaliveIntervalMs?: number } | undefined)?.keepaliveIntervalMs ??
          (connPsd as { keepaliveIntervalMs?: number } | undefined)?.keepaliveIntervalMs ??
          15000;

        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          let abortedByClient = false;
          const onAbort = () => {
            abortedByClient = true;
            try {
              writer.abort(signal?.reason).catch(() => {});
            } catch {
              // ignore
            }
          };

          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });

          try {
            // Immediately send an initial keepalive ping frame
            await writer.write(encoder.encode(": ping\n\n"));
            let lastPingTime = Date.now();

            while (true) {
              if (signal?.aborted || abortedByClient) {
                break;
              }

              const elapsedMs = Date.now() - pollStartTime;
              if (elapsedMs >= timeoutMs) {
                const timeoutMsg = sanitizeErrorMessage(
                  `Gemini Deep Think timed out after ${timeoutMs}ms`
                );
                const errPayload = buildErrorBody(504, timeoutMsg, null, {
                  type: "timeout_error",
                  code: GEMINI_DEEP_THINK_TIMEOUT_CODE,
                });
                await writer.write(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                break;
              }

              const remainingTime = timeoutMs - elapsedMs;
              const sleepTime = Math.min(pollIntervalMs, remainingTime);
              await sleepWithSignal(sleepTime, signal ?? undefined);

              if (signal?.aborted || abortedByClient) {
                break;
              }

              const now = Date.now();
              if (now - lastPingTime >= Math.min(pollIntervalMs, keepaliveIntervalMs)) {
                await writer.write(encoder.encode(": ping\n\n"));
                lastPingTime = now;
              }

              const pollReqId = Math.floor(Math.random() * 900000) + 100000;
              const pollUrl = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2F${encodeURIComponent(conversationId)}&bl=${encodeURIComponent(buildLabel)}&f.sid=${encodeURIComponent(fSid)}&hl=en&_reqid=${pollReqId}&rt=c`;

              const pollParams = buildPollRequestBody(conversationId, atToken);
              const pollHeaders: Record<string, string> = {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                Cookie: cookie,
                "x-same-domain": "1",
              };

              const pollResp = await fetchFn(pollUrl, {
                method: "POST",
                headers: pollHeaders,
                body: pollParams.toString(),
                signal: signal ?? undefined,
              });

              if (!pollResp.ok) {
                if (pollResp.status === 401 || pollResp.status === 403) {
                  clearCachedSession(cookie);
                  const errPayload = buildErrorBody(
                    401,
                    sanitizeErrorMessage(`Gemini poll session expired: HTTP ${pollResp.status}`),
                    null,
                    {
                      type: "authentication_error",
                      code: "gemini_web_auth_required",
                    }
                  );
                  await writer.write(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
                  await writer.write(encoder.encode("data: [DONE]\n\n"));
                  break;
                }
                continue;
              }

              await this.persistRotatedCookiesFromHeaders(
                pollResp.headers,
                cookie,
                credentials,
                onCredentialsRefreshed,
                log
              );

              const pollRawText = await pollResp.text();
              const pollResult = parsePollResponse(pollRawText);

              if (pollResult.isFailed) {
                const errPayload = buildErrorBody(
                  502,
                  sanitizeErrorMessage(pollResult.error || "Gemini Deep Think generation failed"),
                  null,
                  {
                    type: "server_error",
                    code: "gemini_deep_think_generation_failed",
                  }
                );
                await writer.write(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                break;
              }

              if (!pollResult.isPending && pollResult.text) {
                const text = pollResult.text;
                if (hasTools) {
                  const cid = `chatcmpl-gwe-${crypto.randomUUID().slice(0, 12)}`;
                  const created = Math.floor(Date.now() / 1000);
                  const toolResponse = await buildGeminiToolResponse(
                    text,
                    requestedTools,
                    true,
                    modelId,
                    cid,
                    created
                  );
                  if (toolResponse.body) {
                    const toolReader = toolResponse.body.getReader();
                    while (true) {
                      const { done, value } = await toolReader.read();
                      if (done) break;
                      await writer.write(value);
                    }
                  }
                } else {
                  await writer.write(
                    encoder.encode(`data: ${JSON.stringify(formatStreamChunk(text, modelId))}\n\n`)
                  );
                  await writer.write(
                    encoder.encode(
                      `data: ${JSON.stringify(formatStreamChunk("", modelId, "stop"))}\n\n`
                    )
                  );
                  await writer.write(encoder.encode("data: [DONE]\n\n"));
                }
                break;
              }
            }
          } catch (err) {
            if (!signal?.aborted && !abortedByClient) {
              try {
                const msg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
                const errPayload = buildErrorBody(500, msg, null, {
                  type: "server_error",
                  code: "gemini_deep_think_streaming_error",
                });
                await writer.write(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
              } catch {
                // ignore
              }
            }
          } finally {
            signal?.removeEventListener("abort", onAbort);
            try {
              await writer.close();
            } catch {
              // ignore
            }
          }
        })();

        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      } else {
        // 3. Polling loop for hNvQHb
        const conversationId = envelope.conversationId;
        const pollStartTime = Date.now();
        const pollIntervalMs =
          (credPsd as { pollIntervalMs?: number } | undefined)?.pollIntervalMs ??
          (connPsd as { pollIntervalMs?: number } | undefined)?.pollIntervalMs ??
          1500;

        while (true) {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
          }

          const elapsedMs = Date.now() - pollStartTime;
          if (elapsedMs >= timeoutMs) {
            return {
              response: new Response(
                JSON.stringify(
                  buildErrorBody(504, `Gemini Deep Think timed out after ${timeoutMs}ms`, null, {
                    type: "timeout_error",
                    code: GEMINI_DEEP_THINK_TIMEOUT_CODE,
                  })
                ),
                { status: 504, headers: { "Content-Type": "application/json" } }
              ),
              url: GEMINI_URL,
              headers: {},
              transformedBody: body,
            };
          }

          const remainingTime = timeoutMs - elapsedMs;
          const sleepTime = Math.min(pollIntervalMs, remainingTime);
          await sleepWithSignal(sleepTime, signal ?? undefined);

          const pollReqId = Math.floor(Math.random() * 900000) + 100000;
          const pollUrl = `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2F${encodeURIComponent(conversationId)}&bl=${encodeURIComponent(buildLabel)}&f.sid=${encodeURIComponent(fSid)}&hl=en&_reqid=${pollReqId}&rt=c`;

          const pollParams = buildPollRequestBody(conversationId, atToken);
          const pollHeaders: Record<string, string> = {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Cookie: cookie,
            "x-same-domain": "1",
          };

          const pollResp = await fetchFn(pollUrl, {
            method: "POST",
            headers: pollHeaders,
            body: pollParams.toString(),
            signal: signal ?? undefined,
          });

          if (!pollResp.ok) {
            if (pollResp.status === 401 || pollResp.status === 403) {
              clearCachedSession(cookie);
              return {
                response: new Response(
                  JSON.stringify(
                    buildErrorBody(
                      401,
                      `Gemini poll session expired: HTTP ${pollResp.status}`,
                      null,
                      {
                        type: "authentication_error",
                        code: "gemini_web_auth_required",
                      }
                    )
                  ),
                  { status: 401, headers: { "Content-Type": "application/json" } }
                ),
                url: GEMINI_URL,
                headers: {},
                transformedBody: body,
              };
            }
            continue;
          }

          await this.persistRotatedCookiesFromHeaders(
            pollResp.headers,
            cookie,
            credentials,
            onCredentialsRefreshed,
            log
          );

          const pollRawText = await pollResp.text();
          const pollResult = parsePollResponse(pollRawText);

          if (pollResult.isFailed) {
            return {
              response: new Response(
                JSON.stringify(
                  buildErrorBody(
                    502,
                    pollResult.error || "Gemini Deep Think generation failed",
                    null,
                    {
                      type: "server_error",
                      code: "gemini_deep_think_generation_failed",
                    }
                  )
                ),
                { status: 502, headers: { "Content-Type": "application/json" } }
              ),
              url: GEMINI_URL,
              headers: {},
              transformedBody: body,
            };
          }

          if (!pollResult.isPending && pollResult.text) {
            finalResponseText = pollResult.text;
            break;
          }
        }
      }

      if (!finalResponseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      return this.buildFormattedResponse({
        responseText: finalResponseText,
        modelId,
        hasTools,
        requestedTools,
        stream: Boolean(stream),
        body,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      const errorCode = (error as { code?: string } | null)?.code;
      const errorStatus = (error as { status?: number } | null)?.status;

      if (errorCode === GEMINI_DEEP_THINK_TIMEOUT_CODE || errorStatus === 504) {
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(504, rawMessage, null, {
                type: "timeout_error",
                code: GEMINI_DEEP_THINK_TIMEOUT_CODE,
              })
            ),
            { status: 504, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      if (
        errorCode === "gemini_deep_think_generation_failed" ||
        rawMessage.includes("gemini_deep_think_generation_failed")
      ) {
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(502, rawMessage, null, {
                type: "server_error",
                code: "gemini_deep_think_generation_failed",
              })
            ),
            { status: 502, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      if (
        errorCode === "gemini_web_auth_required" ||
        rawMessage.includes("gemini_web_auth_required")
      ) {
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(401, rawMessage, null, {
                type: "authentication_error",
                code: "gemini_web_auth_required",
              })
            ),
            { status: 401, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      return {
        response: new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(rawMessage),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }
  }

  async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal, log, onCredentialsRefreshed } = input;
    const requestBody = body as GeminiRequestBody;

    const rawModel = model || (body as { model?: string })?.model || "";
    const modelId = rawModel.replace(/^(?:gweb|gemini-web)\//, "") || "gemini-2.5-pro";

    // #9356: fail fast on controls this provider cannot honor (reasoning_effort
    // above "minimal", forced tool_choice). Runs before the credential check and
    // before Playwright launches — the request is unservable no matter which
    // cookie is used, and answering 200 with ordinary prose made agents believe
    // their reasoning/tool requirements had been met. See ./gemini-web/capabilities.ts.
    const violation = checkGeminiWebUnsupportedControls(body as Record<string, unknown>, modelId);
    if (violation) {
      log?.warn?.(
        "GEMINI-WEB",
        `Rejected request: "${violation.param}" is not supported by this provider`
      );
      return {
        response: new Response(
          JSON.stringify(
            buildErrorBody(400, violation.message, null, {
              type: "invalid_request_error",
              code: GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
            })
          ),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const cookie = resolveGeminiWebCookie(credentials);
    if (!cookie) {
      return {
        response: new Response(JSON.stringify({ error: "Missing Gemini cookies" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const useBrowserAutomation =
      (
        credentials?.providerSpecificData as
          { browserAutomation?: boolean; engine?: string } | undefined
      )?.browserAutomation === true ||
      (credentials?.providerSpecificData as { engine?: string } | undefined)?.engine === "browser";

    const messages = requestBody.messages || [];

    let hasTools = false;
    let requestedTools: unknown = undefined;
    let prompt: string;

    if (isDeepThinkModel(modelId) && !useBrowserAutomation) {
      hasTools = false;
      requestedTools = undefined;
      const purified = purifyDeepThinkPrompt(messages, (body as { system?: unknown })?.system);
      prompt = purified.prompt;
    } else {
      const toolPrep = prepareToolMessages(body as Record<string, unknown>, messages);
      hasTools = toolPrep.hasTools;
      requestedTools = toolPrep.requestedTools;

      // hasTools === false: flatten the full multi-turn history into the single
      // prompt so gemini-web (a stateless web-cookie provider that captures only
      // the first StreamGenerate response) preserves prior context across turns
      // (#8371). Single-turn requests stay byte-for-byte identical to the original
      // derivation, keeping the #7286 no-tools regression guard intact.
      prompt = hasTools
        ? buildGeminiToolPrompt(toolPrep.effectiveMessages)
        : buildGeminiPrompt(messages);
    }

    if (!prompt) {
      return {
        response: new Response(JSON.stringify({ error: "No user message found" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    }

    if (isDeepThinkModel(modelId) && !useBrowserAutomation) {
      return this.executeDirectDeepThink({
        input,
        cookie,
        prompt,
        modelId,
        hasTools,
        requestedTools,
      });
    }

    let browser: import("playwright").Browser | null = null;
    let abortBrowser: (() => void) | null = null;
    try {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      abortBrowser = () => {
        void browser?.close().catch(() => {});
      };
      signal?.addEventListener("abort", abortBrowser, { once: true });

      const context = await browser.newContext({ userAgent: GEMINI_USER_AGENT });

      // Parse cookies — strips attributes like Path, Domain, Expires
      const cookiePairs = parseCookies(cookie);
      await context.addCookies(
        cookiePairs.map(({ name, value }) => {
          if (name.startsWith("__Host-")) {
            return {
              name,
              value,
              url: "https://gemini.google.com",
              path: "/",
              secure: true,
            };
          }
          return {
            name,
            value,
            domain: ".google.com",
            path: "/",
            secure: true,
          };
        })
      );

      const page = await context.newPage();

      // Capture first StreamGenerate response
      let responseText = "";
      if (modelId === "gemini-deep-think") {
        await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
        }
        await page.waitForTimeout(3000);

        const timeoutMs = resolveDeepThinkTimeoutMs(
          (credentials?.providerSpecificData as { timeoutMs?: number } | undefined)?.timeoutMs
        );

        const { runGeminiDeepThinkUiStateMachine } =
          await import("./gemini-web/browserAutomation.ts");
        const rawResult = await runGeminiDeepThinkUiStateMachine({
          page,
          prompt,
          signal: signal ?? undefined,
          timeoutMs,
        });
        responseText = parseStreamResponse(rawResult);
      } else {
        let captured = false;
        const responsePromise = new Promise<void>((resolve) => {
          page.on("response", async (resp: { url: () => string; text: () => Promise<string> }) => {
            if (!resp.url().includes("StreamGenerate")) return;
            if (captured) return;
            // Resolve even if reading the body throws, so the flow falls through
            // to the "No response from Gemini" 502 instead of burning the full
            // wait window.
            captured = true;
            try {
              const raw = await resp.text();
              responseText = parseStreamResponse(raw);
            } catch {
              /* ignore */
            }
            resolve();
          });
        });

        await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
        }
        await page.waitForTimeout(3000);

        // Type and send message
        const inputEl = await page.waitForSelector(".ql-editor, [contenteditable='true']", {
          timeout: 10000,
        });
        await inputEl.click();
        await page.keyboard.type(prompt, { delay: 10 });
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");

        await Promise.race([responsePromise, page.waitForTimeout(30000)]);
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
        }
      }

      if (!responseText) {
        return {
          response: new Response(JSON.stringify({ error: "No response from Gemini" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      await this.persistRotatedCookies(context, cookie, credentials, onCredentialsRefreshed, log);

      return this.buildFormattedResponse({
        responseText,
        modelId,
        hasTools,
        requestedTools,
        stream: Boolean(stream),
        body,
      });
    } catch (error) {
      if (
        (error as { name?: string })?.name === "GeminiWebUiStateError" ||
        (error as { code?: string })?.code === "gemini_deep_think_unavailable" ||
        (error as { code?: string })?.code === "gemini_web_ui_contract_mismatch"
      ) {
        const uiError = error as { status?: number; message?: string; code?: string };
        const status = uiError.status || 409;
        const msg = uiError.message || "Gemini Web UI state error";
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(status, msg, null, {
                type:
                  status === 401
                    ? "authentication_error"
                    : status >= 500
                      ? "server_error"
                      : "invalid_request_error",
                code: uiError.code,
              })
            ),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }

      const rawMessage = error instanceof Error ? error.message : "Unknown error";
      const errorCode = (error as { code?: string } | null)?.code;
      const errorStatus = (error as { status?: number } | null)?.status;

      if (errorCode === GEMINI_DEEP_THINK_TIMEOUT_CODE || errorStatus === 504) {
        return {
          response: new Response(
            JSON.stringify(
              buildErrorBody(504, rawMessage, null, {
                type: "timeout_error",
                code: GEMINI_DEEP_THINK_TIMEOUT_CODE,
              })
            ),
            {
              status: 504,
              headers: { "Content-Type": "application/json" },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      // #3516: a missing Playwright browser is a host/config problem, not a transient upstream
      // fault. Surface an actionable error and tag it with the connection-cooldown hint so
      // accountFallback skips the provider circuit breaker and applies a short, non-exponential
      // cooldown instead of looping on a retryable 500.
      if (isMissingBrowserExecutable(rawMessage)) {
        return {
          response: new Response(
            JSON.stringify({
              error:
                "Gemini Web requires the Playwright Chromium browser, which is not installed. " +
                "Run `npx playwright install chromium` on the host (or rebuild the Docker image with browsers).",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Omni-Fallback-Hint": "connection_cooldown",
              },
            }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      // #9407: Playwright selector/click timeout errors are terminal — they indicate
      // the page DOM does not match expectations (e.g. Gemini changed their UI or
      // the session is so expired it lands on a different page). Return 400 so the
      // account-fallback system does NOT retry this request as a transient 5xx.
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          rawMessage.includes("waitForSelector") ||
          rawMessage.includes("Timeout") ||
          rawMessage.includes("actionability") ||
          rawMessage.includes("interception"))
      ) {
        return {
          response: new Response(
            JSON.stringify({
              error: sanitizeErrorMessage(rawMessage),
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          ),
          url: GEMINI_URL,
          headers: {},
          transformedBody: body,
        };
      }
      return {
        response: new Response(
          JSON.stringify({
            error: sanitizeErrorMessage(rawMessage),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        ),
        url: GEMINI_URL,
        headers: {},
        transformedBody: body,
      };
    } finally {
      if (abortBrowser) signal?.removeEventListener("abort", abortBrowser);
      // Always close browser to prevent resource leaks
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore close errors */
        }
      }
    }
  }
}
