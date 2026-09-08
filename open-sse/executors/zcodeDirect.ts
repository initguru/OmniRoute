import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { ZcodeCaptchaSolver } from "../services/zcodeCaptchaSolver.ts";
import {
  buildZcodeDirectBody,
  buildZcodeDirectHeaders,
  classifyZcodeDirectError,
  resolveZcodeDirectAuth,
  resolveZcodeModel,
  type ZcodeDirectAuthOptions,
} from "../services/zcodeDirectProtocol.ts";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";

const DEFAULT_ENDPOINT = "https://zcode.z.ai/api/v1/zcode-plan/chat/completions";
const MAX_CAPTCHA_RETRIES = 1;

type JsonRecord = Record<string, unknown>;
type CaptchaToken = { verifyParam: string; region: string };

type CaptchaSolveOptions = {
  signal?: AbortSignal | null;
  timeoutMs?: number;
};

/** The narrow solver contract makes browser captcha work injectable in tests. */
export interface ZcodeCaptchaSolver {
  solve(options?: CaptchaSolveOptions): Promise<CaptchaToken>;
  invalidate: () => void | Promise<void>;
}

export interface ZcodeDirectExecutorOptions {
  captchaSolver?: ZcodeCaptchaSolver;
  fetcher?: typeof fetch;
  authOptions?: ZcodeDirectAuthOptions | unknown;
  endpoint?: string;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function errorMessage(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}

function endpointFor(baseURL: string, configured?: string): string {
  const raw = configured?.trim() || baseURL.trim() || DEFAULT_ENDPOINT;
  if (/\/chat\/completions(?:\/?(?:\?.*)?)?$/i.test(raw)) return raw;
  const base = raw.replace(/\/anthropic\/?$/i, "").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

function sseErrorResponse(status: number, message: string): Response {
  const body = `data: ${JSON.stringify(buildErrorBody(status, message))}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-omniroute-error-status": String(status),
    },
  });
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function readMessages(body: JsonRecord): unknown[] {
  return Array.isArray(body.messages) ? body.messages : [];
}

function buildRequestBody(
  body: JsonRecord,
  model: string,
  stream: boolean
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...body,
    model,
    messages: readMessages(body),
    stream,
  };
  return buildZcodeDirectBody(params);
}

function unwrapSsePayload(value: unknown): unknown {
  const record = asRecord(value);
  if (record.data !== undefined && Object.keys(record).length <= 2) return record.data;
  return value;
}

function parseSsePayload(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return data === "[DONE]" ? "[DONE]" : null;
  try {
    return unwrapSsePayload(JSON.parse(data));
  } catch {
    return null;
  }
}

function normalizeChunk(payload: unknown, model: string): JsonRecord | null {
  const record = asRecord(payload);
  if (Object.keys(record).length === 0) return null;
  if (record.error !== undefined) {
    const rawError = record.error;
    if (typeof rawError === "string") {
      return { ...record, error: sanitizeErrorMessage(rawError) };
    }
    const error = asRecord(rawError);
    if (Object.keys(error).length === 0) return record;
    return {
      ...record,
      error: {
        ...error,
        ...(typeof error.message === "string"
          ? { message: sanitizeErrorMessage(error.message) }
          : {}),
        ...(typeof error.msg === "string" ? { msg: sanitizeErrorMessage(error.msg) } : {}),
      },
    };
  }
  const choices = Array.isArray(record.choices) ? record.choices : undefined;
  if (choices) {
    return {
      ...record,
      object: typeof record.object === "string" ? record.object : "chat.completion.chunk",
      model: typeof record.model === "string" ? record.model : model,
      choices,
    };
  }
  const usage = asRecord(record.usage);
  if (Object.keys(usage).length > 0) {
    return {
      id: typeof record.id === "string" ? record.id : `chatcmpl-zcode-${Date.now()}`,
      object: "chat.completion.chunk",
      created: typeof record.created === "number" ? record.created : Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage,
    };
  }
  return null;
}

function createStreamingResponse(
  upstream: Response,
  model: string,
  signal?: AbortSignal | null
): Response {
  if (!upstream.body) return new Response("data: [DONE]\n\n", { status: 200 });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let finished = false;
  let abortHandler: (() => void) | undefined;

  const cleanupAbortListener = () => {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }
  };
  const cancelReader = (reason?: unknown) => {
    if (finished) return;
    finished = true;
    cleanupAbortListener();
    void reader.cancel(reason).catch(() => undefined);
  };
  if (signal) {
    abortHandler = () => cancelReader(signal.reason);
    if (signal.aborted) cancelReader(signal.reason);
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  const output = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          const tail = decoder.decode();
          buffer += tail;
          if (buffer.trim()) {
            const payload = parseSsePayload(buffer);
            const chunk = payload && payload !== "[DONE]" ? normalizeChunk(payload, model) : null;
            if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          finished = true;
          cleanupAbortListener();
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          const payload = parseSsePayload(line);
          if (payload === "[DONE]") {
            finished = true;
            cleanupAbortListener();
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          if (payload === null) continue;
          const chunk = normalizeChunk(payload, model);
          if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      } catch (error) {
        finished = true;
        cleanupAbortListener();
        if (signal?.aborted) {
          controller.close();
          return;
        }
        controller.error(new Error(errorMessage(error) || "ZCode direct stream failed"));
      }
    },
    cancel(reason) {
      cancelReader(reason);
    },
  });

  return new Response(output, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export class ZcodeDirectExecutor extends BaseExecutor {
  private readonly options: Required<Pick<ZcodeDirectExecutorOptions, "fetcher">> &
    Omit<ZcodeDirectExecutorOptions, "fetcher">;

  constructor(options: ZcodeDirectExecutorOptions = {}) {
    super("zcode-direct", {
      id: "zcode-direct",
      baseUrl: DEFAULT_ENDPOINT,
      format: "openai",
    });
    this.options = {
      ...options,
      fetcher: options.fetcher ?? fetch,
      captchaSolver:
        options.captchaSolver ?? (new ZcodeCaptchaSolver() as unknown as ZcodeCaptchaSolver),
    };
  }

  override buildUrl(): string {
    return this.options.endpoint || DEFAULT_ENDPOINT;
  }

  override transformRequest(): null {
    return null;
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    if (input.signal?.aborted) {
      return input.stream
        ? sseErrorResponse(499, "Request aborted")
        : errorResponse(499, "Request aborted");
    }

    const resolution = resolveZcodeModel(input.model);
    if (!resolution.ok) {
      const message = "error" in resolution ? resolution.error : "Invalid ZCode model";
      return input.stream ? sseErrorResponse(400, message) : errorResponse(400, message);
    }

    const auth = resolveZcodeDirectAuth(this.options.authOptions);
    if (!auth) {
      const message = "ZCode direct API credentials are missing or invalid";
      return input.stream ? sseErrorResponse(401, message) : errorResponse(401, message);
    }

    const body = asRecord(input.body);
    const endpoint = endpointFor(auth.baseURL, this.options.endpoint);
    let retries = 0;

    while (true) {
      try {
        const captcha = await this.options.captchaSolver!.solve({ signal: input.signal });
        const headers = buildZcodeDirectHeaders({
          apiKey: auth.apiKey,
          verifyParam: captcha.verifyParam,
          region: captcha.region,
        });
        const requestBody = buildRequestBody(body, resolution.model, input.stream);
        const upstream = await this.options.fetcher(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: input.signal ?? undefined,
        });

        if (!upstream.ok) {
          const errorData = parseJsonText(await upstream.text());
          const classification = classifyZcodeDirectError(upstream.status, errorData);
          if (classification.isCaptchaError && retries < MAX_CAPTCHA_RETRIES) {
            retries += 1;
            await this.options.captchaSolver!.invalidate();
            continue;
          }
          return input.stream
            ? sseErrorResponse(upstream.status, classification.message)
            : errorResponse(upstream.status, classification.message);
        }

        const response = input.stream
          ? createStreamingResponse(upstream, resolution.model, input.signal)
          : new Response(await upstream.text(), {
              status: upstream.status,
              headers: {
                "content-type": upstream.headers.get("content-type") || "application/json",
              },
            });
        return {
          response,
          url: endpoint,
          headers,
          transformedBody: requestBody,
          transport: "zcode-direct-api",
        };
      } catch (error) {
        const message = errorMessage(error) || "ZCode direct API request failed";
        return input.stream ? sseErrorResponse(502, message) : errorResponse(502, message);
      }
    }
  }
}
