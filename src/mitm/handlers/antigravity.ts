/**
 * Antigravity IDE handler.
 *
 * Antigravity (the Gemini-based IDE) sends requests in native Gemini
 * GenerateContent format (`contents`, `systemInstruction`, `generationConfig`,
 * `thinkingConfig`, …). The OmniRoute router endpoint `/v1/chat/completions`
 * expects OpenAI Chat Completions format, so the raw Gemini body must be
 * converted before forwarding — otherwise the unknown fields are either
 * ignored or cause upstream providers to return a 400 "invalid argument"
 * error (especially with thinking-capable models such as
 * `ag/claude-opus-4-6-thinking`).
 *
 * Pipeline:
 *   - parse the incoming Gemini JSON body,
 *   - convert it to an OpenAI chat.completions body (model = mapped model),
 *   - forward to `/v1/chat/completions` on the OmniRoute router,
 *   - pipe the SSE response back to the IDE.
 *
 * Non-regressive: any change here must keep the Antigravity flow working as
 * before (see `tests/unit/mitm-handler-antigravity.test.ts`).
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AgentId } from "../types";
import { MitmHandlerBase } from "./base";
import { TOOL_RENAME_MAP } from "@omniroute/open-sse/services/claudeCodeToolRemapper";

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

interface GeminiRequestBody {
  systemInstruction?: GeminiContent;
  contents?: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
  /**
   * Antigravity IDE talks to `cloudcode-pa.googleapis.com/v1internal:generateContent`,
   * whose envelope nests the real Gemini request one level down:
   *   `{ project, model, userAgent, requestType, request: { contents, systemInstruction,
   *      generationConfig, … } }`
   * (see `open-sse/translator/request/antigravity-to-openai.ts`). The legacy
   * `/v1beta/models/<model>:generateContent` path instead carries those fields at the top
   * level. We must read whichever level actually holds the conversation (#4294).
   */
  request?: GeminiRequestBody;
  [key: string]: unknown;
}

/**
 * Return the object that actually holds the Gemini conversation fields. Antigravity's
 * cloudcode-pa envelope wraps them under `.request`; the legacy `/v1beta` path puts them at
 * the top level. Without this unwrap, a real Antigravity request yields zero messages, so
 * the upstream gets an empty conversation and the IDE prompt hangs (#4294).
 */
function resolveGeminiSource(body: GeminiRequestBody): GeminiRequestBody {
  const inner = body.request;
  if (
    inner &&
    typeof inner === "object" &&
    ("contents" in inner || "systemInstruction" in inner || "generationConfig" in inner)
  ) {
    return inner;
  }
  return body;
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const TOOL_NAME_MARKER_PREFIX = Buffer.from('"name"', "ascii");
const TOOL_NAME_WHITESPACE_CAP = 16;
const TOOL_NAME_KEYS = Object.keys(TOOL_RENAME_MAP);
const MAX_TOOL_NAME_KEY_LENGTH = TOOL_NAME_KEYS.reduce(
  (max, key) => Math.max(max, Buffer.byteLength(key)),
  0
);
const MAX_TOOL_NAME_CANDIDATE_BYTES =
  TOOL_NAME_MARKER_PREFIX.length +
  TOOL_NAME_WHITESPACE_CAP * 2 +
  1 +
  1 +
  MAX_TOOL_NAME_KEY_LENGTH +
  1;

function isAsciiWhitespace(byte: number): boolean {
  return (
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

function isToolNameByte(byte: number): boolean {
  return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f;
}

type ToolMarkerParse =
  { kind: "invalid" } | { kind: "potential" } | { kind: "complete"; name: string };

function parseToolMarker(candidate: number[]): ToolMarkerParse {
  if (candidate.length > MAX_TOOL_NAME_CANDIDATE_BYTES) return { kind: "invalid" };
  const prefixLength = TOOL_NAME_MARKER_PREFIX.length;
  for (let index = 0; index < Math.min(candidate.length, prefixLength); index++) {
    if (candidate[index] !== TOOL_NAME_MARKER_PREFIX[index]) return { kind: "invalid" };
  }
  if (candidate.length <= prefixLength) return { kind: "potential" };

  let index = prefixLength;
  let whitespace = 0;
  while (index < candidate.length && isAsciiWhitespace(candidate[index])) {
    whitespace++;
    if (whitespace > TOOL_NAME_WHITESPACE_CAP) return { kind: "invalid" };
    index++;
  }
  if (index === candidate.length) return { kind: "potential" };
  if (candidate[index] !== 0x3a) return { kind: "invalid" };
  index++;
  if (index === candidate.length) return { kind: "potential" };

  whitespace = 0;
  while (index < candidate.length && isAsciiWhitespace(candidate[index])) {
    whitespace++;
    if (whitespace > TOOL_NAME_WHITESPACE_CAP) return { kind: "invalid" };
    index++;
  }
  if (index === candidate.length) return { kind: "potential" };
  if (candidate[index] !== 0x22) return { kind: "invalid" };
  index++;
  if (index === candidate.length) return { kind: "potential" };

  const keyStart = index;
  while (index < candidate.length && isToolNameByte(candidate[index])) index++;
  const key = Buffer.from(candidate.slice(keyStart, index)).toString("ascii");
  if (!key || key.length > MAX_TOOL_NAME_KEY_LENGTH) return { kind: "invalid" };
  if (!TOOL_NAME_KEYS.some((known) => known.startsWith(key))) return { kind: "invalid" };
  if (index === candidate.length) return { kind: "potential" };
  if (candidate[index] !== 0x22 || index + 1 !== candidate.length) {
    return { kind: "invalid" };
  }
  const replacement = TOOL_RENAME_MAP[key];
  return replacement ? { kind: "complete", name: replacement } : { kind: "invalid" };
}

function createToolNameRestoringResponse(
  res: ServerResponse,
  onCollected: (chunk: Buffer) => void
): ServerResponse {
  const pending: number[] = [];

  const transform = (chunk: Buffer, flush = false): Buffer => {
    const output: number[] = [];
    const emitPending = () => {
      output.push(...pending);
      pending.length = 0;
    };

    for (const inputByte of chunk) {
      let byte = inputByte;
      let retry = true;
      while (retry) {
        retry = false;
        if (pending.length === 0) {
          if (byte === 0x22) pending.push(byte);
          else output.push(byte);
          continue;
        }

        pending.push(byte);
        const parsed = parseToolMarker(pending);
        if (parsed.kind === "complete") {
          output.push(...Buffer.from(`"name":"${parsed.name}"`, "ascii"));
          pending.length = 0;
        } else if (parsed.kind === "invalid") {
          const current = pending.pop()!;
          emitPending();
          byte = current;
          retry = true;
        }
      }
    }

    if (flush) emitPending();
    return Buffer.from(output);
  };

  const writeRestored = (chunk: Buffer | string): Buffer => {
    const restored = transform(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    onCollected(restored);
    return restored;
  };

  return {
    get headersSent() {
      return res.headersSent;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      return res.writeHead(statusCode, headers);
    },
    write(chunk: Buffer | string) {
      return res.write(writeRestored(chunk));
    },
    end(chunk?: Buffer | string) {
      const restored = transform(
        chunk === undefined ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        true
      );
      if (restored.length > 0) onCollected(restored);
      return res.end(restored.length > 0 ? restored : undefined);
    },
  } as unknown as ServerResponse;
}

const INBOUND_IDENTITY_HEADERS = new Set([
  "user-agent",
  "x-client-profile",
  "clientprofile",
  "x-omniroute-agent",
  "x-omniroute-connection",
  "x-omniroute-source",
]);

function antigravityRouterHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const trusted: IncomingHttpHeaders = {
    "x-omniroute-source": "agent-bridge",
    "x-omniroute-agent": "antigravity",
  };
  for (const [name, value] of Object.entries(headers)) {
    if (INBOUND_IDENTITY_HEADERS.has(name.toLowerCase())) continue;
    trusted[name] = value;
  }
  return trusted;
}

interface OpenAIChatBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

function joinPartsText(parts: GeminiPart[] | undefined): string {
  return (parts || [])
    .map((p) => p.text)
    .filter((t): t is string => Boolean(t))
    .join("\n");
}

/**
 * Convert a Gemini GenerateContent request body to an OpenAI
 * chat.completions body.
 *
 * @param geminiBody parsed Gemini request
 * @param model      resolved OmniRoute model string
 * @param stream     whether the original request was streaming
 */
export function convertGeminiToOpenAI(
  geminiBody: GeminiRequestBody,
  model: string,
  stream: boolean
): OpenAIChatBody {
  // Unwrap the cloudcode-pa envelope (`.request`) used by the real Antigravity IDE; fall
  // back to the top level for the legacy `/v1beta` shape. (#4294)
  const src = resolveGeminiSource(geminiBody);

  const messages: OpenAIChatMessage[] = [];

  // System instruction
  if (src.systemInstruction) {
    const systemText = joinPartsText(src.systemInstruction.parts);
    if (systemText) messages.push({ role: "system", content: systemText });
  }

  // Chat turns
  for (const content of src.contents || []) {
    const role: OpenAIChatMessage["role"] = content.role === "model" ? "assistant" : "user";
    messages.push({ role, content: joinPartsText(content.parts) });
  }

  const openaiBody: OpenAIChatBody = {
    model,
    messages,
    stream: !!stream,
  };

  const cfg = src.generationConfig || {};
  if (cfg.maxOutputTokens != null) openaiBody.max_tokens = cfg.maxOutputTokens;
  if (cfg.temperature != null) openaiBody.temperature = cfg.temperature;
  if (cfg.topP != null) openaiBody.top_p = cfg.topP;
  if (cfg.stopSequences?.length) openaiBody.stop = cfg.stopSequences;

  return openaiBody;
}

export class AntigravityHandler extends MitmHandlerBase {
  readonly agentId: AgentId = "antigravity";

  async intercept(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    mappedModel: string
  ): Promise<void> {
    const startedAt = this.now();
    const intercepted = await this.hookBufferStart(req, body, mappedModel);

    try {
      const geminiBody = JSON.parse(body.toString()) as GeminiRequestBody;

      // Streaming intent: Antigravity uses :streamGenerateContent for streaming.
      const isStream = (req.url || "").includes(":streamGenerateContent");

      const payload = convertGeminiToOpenAI(geminiBody, mappedModel, isStream);

      const upstreamStart = this.now();
      const upstream = await this.fetchRouter(
        payload,
        "/v1/chat/completions",
        antigravityRouterHeaders(req.headers)
      );

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => "");
        throw new Error(`OmniRoute ${upstream.status}: ${errText}`);
      }

      const collectedChunks: Buffer[] = [];
      await this.pipeSSE(
        upstream,
        createToolNameRestoringResponse(res, (chunk) => {
          collectedChunks.push(chunk);
        })
      );
      const collected = Buffer.concat(collectedChunks).toString("utf8");

      const total = this.now() - startedAt;
      this.hookBufferUpdate(intercepted, {
        status: upstream.status,
        responseHeaders: Object.fromEntries(upstream.headers.entries()),
        responseBody: collected,
        responseSize: Buffer.byteLength(collected),
        proxyLatencyMs: upstreamStart - startedAt,
        upstreamLatencyMs: total - (upstreamStart - startedAt),
      });
    } catch (err) {
      await this.hookBufferError(intercepted, err);
      await this.writeError(res, err);
    }
  }
}
