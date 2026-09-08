import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  BaseExecutor,
  type ExecuteInput,
  type ExecutorExecuteResult,
  type ProviderCredentials,
} from "./base.ts";
import {
  ZcodeAppServerClient,
  type ZcodeClientLike,
  type ZcodeIncomingRequestHandler,
  type ZcodeNotificationHandler,
} from "./zcodeProtocol.ts";
import { ZcodeCaptchaSolver } from "../services/zcodeCaptchaSolver.ts";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import {
  ZcodeDirectExecutor,
  type ZcodeDirectExecutorOptions,
  type ZcodeCaptchaSolver as ZcodeDirectCaptchaSolver,
} from "./zcodeDirect.ts";
import { resolveZcodeModel, type ZcodeModelResolution } from "../services/zcodeDirectProtocol.ts";

export { resolveZcodeModel, type ZcodeModelResolution };

const ZCODE_URL = "zcode://app-server/stdio";
const ZCODE_ANTHROPIC_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";
const DEFAULT_PROVIDER_ID = "builtin:zai-start-plan";
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

const CAPTCHA_VERIFY_PARAM_HEADER = "x-aliyun-captcha-verify-param";
const CAPTCHA_VERIFY_REGION_HEADER = "x-aliyun-captcha-verify-region";
const DEFAULT_CAPTCHA_TIMEOUT_MS = 30_000;
const MAX_CAPTCHA_RETRIES = 1;

type JsonRecord = Record<string, unknown>;
type OpenAIMsg = { role?: string; content?: unknown };
type ZcodeCommand = { command: string; args: string[] };
type ZcodeCaptcha = { verifyParam: string; region: string };
type ZcodeCaptchaSolverLike = { solve(options?: { timeoutMs?: number }): Promise<ZcodeCaptcha> };
type ZcodeModelRef = { providerId: string; modelId: string };
type ZcodeTurnUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
};
type ZcodeTurnResult = {
  content: string;
  usage?: ZcodeTurnUsage;
};
type CompletionWaiter = {
  promise: Promise<ZcodeTurnResult>;
  resolve: (result: ZcodeTurnResult | string) => void;
  reject: (error: Error) => void;
};
type RuntimeUpdateResult = {
  appliedModelRuntimeRevision?: unknown;
  changed?: unknown;
  runtimeApplied?: unknown;
};
type ZcodeSessionCacheEntry = {
  client: ZcodeClientLike;
  sessionId: string;
  lastSeen: number;
  sentMessageCount: number;
  sentPromptHash: string;
  messages: OpenAIMsg[];
  model: string;
  notify?: ZcodeNotificationHandler;
};

const ZCODE_SESSION_TTL_MS = 10 * 60 * 1000;

export type ZcodeClientFactoryOptions = {
  onRequest: ZcodeIncomingRequestHandler;
  onNotification?: ZcodeNotificationHandler;
  [key: string]: unknown;
};

export interface ZcodeExecutorOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  providerId?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  clientFactory?: (options?: ZcodeClientFactoryOptions) => ZcodeClientLike;
  captchaSolver?: ZcodeCaptchaSolverLike;
  captchaTimeoutMs?: number;
  directExecutorFactory?: (options?: ZcodeDirectExecutorOptions) => ZcodeDirectExecutor;
  directExecutorOptions?: ZcodeDirectExecutorOptions;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function messageEqual(left: OpenAIMsg, right: OpenAIMsg): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMessagePrefix(previous: OpenAIMsg[], current: OpenAIMsg[]): boolean {
  return (
    previous.length <= current.length &&
    previous.every((message, index) => messageEqual(message, current[index]))
  );
}

function hashPrompt(prompt: string): string {
  let hash = 2166136261;
  for (let index = 0; index < prompt.length; index += 1) {
    hash ^= prompt.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (record.type === "text" || record.type === "input_text" || record.type === "output_text") {
        return typeof record.text === "string" ? record.text : "";
      }
      return "";
    })
    .join("");
}

/** Convert an OpenAI conversation into one explicit ZCode coding turn. */
export function buildZcodePrompt(messages: OpenAIMsg[]): string {
  const parts: string[] = [];
  const userTurnStarts = messages.reduce<number[]>((starts, message, index) => {
    if (String(message.role || "user") === "user") starts.push(index);
    return starts;
  }, []);
  const protectedTurnStart = userTurnStarts[Math.max(0, userTurnStarts.length - 2)] ?? 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const text = textFromContent(message.content).trim();
    if (!text) continue;
    const role = String(message.role || "user");
    const shouldPreserve = role === "system" || index >= protectedTurnStart;
    const renderedText =
      shouldPreserve || (role !== "tool" && text.length <= 1_500)
        ? text
        : `${text.slice(0, 500)}\n... [truncated ${text.length - 800} chars of previous tool output] ...\n${text.slice(-300)}`;
    const label = role === "system" ? "System" : role === "assistant" ? "Assistant" : "User";
    parts.push(`[${label}]\n${renderedText}`);
  }
  return parts.join("\n\n") || "(empty)";
}

function defaultCommand(): ZcodeCommand {
  const entry =
    process.env.ZCODE_SERVER_ENTRY || "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
  return {
    command: process.env.ZCODE_SERVER_NODE || process.execPath,
    args: [entry, "app-server"],
  };
}

function extractSessionId(value: unknown): string | undefined {
  const root = asRecord(value);
  const nested = asRecord(root.session);
  const sessionId = nested.sessionId ?? root.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
}

function extractAssistantText(value: unknown): string {
  const root = asRecord(value);
  const messages = Array.isArray(root.messages) ? root.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = asRecord(messages[i]);
    const info = asRecord(message.info);
    const role =
      typeof info.role === "string"
        ? info.role
        : typeof message.role === "string"
          ? message.role
          : undefined;
    if (role && role !== "assistant") continue;
    const content = textFromContent(message.content);
    if (content.trim()) return content;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts
      .map((part) => {
        const record = asRecord(part);
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .join("");
    if (text.trim()) return text;
  }
  for (const candidate of [root.content, root.text, root.output_text, root.response]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

function extractErrorMessage(value: unknown): string {
  const root = asRecord(value);
  const nested = asRecord(root.error);
  for (const candidate of [nested.message, root.message, root.reason]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "ZCode app-server returned an error";
}

function isCaptchaCode(code: unknown): code is 3007 | "3007" | "CAPTCHA_VERIFY_FAILED" {
  return code === 3007 || code === "3007" || code === "CAPTCHA_VERIFY_FAILED";
}

function extractErrorCode(value: unknown): number | string | undefined {
  const visited = new Set<object>();
  const visit = (candidate: unknown, depth: number): number | string | undefined => {
    if (!candidate || typeof candidate !== "object" || depth > 8) return undefined;
    if (visited.has(candidate)) return undefined;
    visited.add(candidate);
    const record = candidate as JsonRecord;
    let firstCode: number | string | undefined;
    for (const code of [record.code, record.providerCode]) {
      if (isCaptchaCode(code)) return code;
      if (firstCode === undefined && (typeof code === "number" || typeof code === "string")) {
        firstCode = code;
      }
    }
    for (const key of ["error", "data", "context", "payload", "details", "cause"]) {
      const nestedCode = visit(record[key], depth + 1);
      if (isCaptchaCode(nestedCode)) return nestedCode;
      if (firstCode === undefined && nestedCode !== undefined) firstCode = nestedCode;
    }
    return firstCode;
  };
  return visit(value, 0);
}

function isCaptchaVerifyFailure(value: unknown): boolean {
  const code = extractErrorCode(value);
  if (code === 3007 || code === "3007" || code === "CAPTCHA_VERIFY_FAILED") return true;
  return /captcha[\s_-]*(?:verify|verification)[\s_-]*(?:failed|failure)/i.test(
    extractErrorMessage(value)
  );
}

function makeWorkspace(cwd: string): JsonRecord {
  return { workspacePath: cwd, workspaceKey: cwd };
}

function abortError(): Error {
  return new Error("ZCode request aborted");
}

function responseFromExecutorResult(result: ExecutorExecuteResult): Response {
  if (result instanceof Response) return result;
  return result.response;
}

function shouldFallbackToStdio(result: ExecutorExecuteResult): boolean {
  const resp = responseFromExecutorResult(result);
  const errorStatusHeader = resp.headers.get("x-omniroute-error-status");
  const status = errorStatusHeader ? Number(errorStatusHeader) : resp.status;
  return status === 401 || status === 403 || status === 404 || status === 405 || status >= 500;
}

function buildDirectExecutorOptions(
  input: ExecuteInput,
  configuredOptions?: ZcodeDirectExecutorOptions
): ZcodeDirectExecutorOptions {
  const credentials = input.credentials;
  const psd = asRecord(credentials?.providerSpecificData);
  const apiKey = credentials?.apiKey || psd.apiKey;
  const baseURL = credentials?.baseUrl || psd.baseUrl || psd.baseURL;

  const requestAuthOptions: Record<string, unknown> = {};
  if (apiKey) requestAuthOptions.apiKey = String(apiKey);
  if (baseURL) requestAuthOptions.baseURL = String(baseURL);

  const mergedAuthOptions = {
    ...asRecord(configuredOptions?.authOptions),
    ...requestAuthOptions,
  };

  return {
    ...configuredOptions,
    ...(Object.keys(mergedAuthOptions).length > 0 ? { authOptions: mergedAuthOptions } : {}),
  };
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw abortError();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function completionResponse(
  model: string,
  prompt: string,
  content: string,
  turnUsage?: ZcodeTurnUsage
): Response {
  const promptTokens = turnUsage?.prompt_tokens ?? Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens =
    turnUsage?.completion_tokens ?? Math.max(1, Math.ceil(content.length / 4));
  const totalTokens = turnUsage?.total_tokens ?? promptTokens + completionTokens;
  return new Response(
    JSON.stringify({
      id: `chatcmpl-zcode-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        ...(turnUsage?.cached_tokens
          ? { prompt_tokens_details: { cached_tokens: turnUsage.cached_tokens } }
          : {}),
        estimated: !turnUsage,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function sseResponse(
  model: string,
  content: string,
  prompt: string,
  turnUsage?: ZcodeTurnUsage
): Response {
  const id = `chatcmpl-zcode-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = turnUsage?.prompt_tokens ?? Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens =
    turnUsage?.completion_tokens ?? Math.max(1, Math.ceil(content.length / 4));
  const totalTokens = turnUsage?.total_tokens ?? promptTokens + completionTokens;
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        ...(turnUsage?.cached_tokens
          ? { prompt_tokens_details: { cached_tokens: turnUsage.cached_tokens } }
          : {}),
      },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function sseErrorResponse(status: number, message: string): Response {
  const body = `data: ${JSON.stringify(buildErrorBody(status, message))}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

const OFFICIAL_MODEL_IDS: Record<string, string> = {
  "glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.3": "GLM-5.3",
  "glm-5.2": "GLM-5.2",
};

function officialModelId(model: string): string {
  return OFFICIAL_MODEL_IDS[model] || model;
}

function assertRuntimeModelApplied(value: unknown, runtimeModel: JsonRecord): void {
  const result = asRecord(value) as RuntimeUpdateResult;
  const revision = runtimeModel.revision;
  const appliedRevision = result.appliedModelRuntimeRevision;
  const applied = result.runtimeApplied;
  if (applied === false || appliedRevision === "model-runtime:unapplied") {
    throw new Error("ZCode runtime model was not applied");
  }
  if (
    typeof appliedRevision === "string" &&
    appliedRevision !== revision &&
    appliedRevision !== "runtime-revision"
  ) {
    throw new Error("ZCode runtime model revision did not match");
  }
}

function loadZcodeApiKey(): string | undefined {
  if (process.env.ZCODE_API_KEY) return process.env.ZCODE_API_KEY;
  try {
    const configPath =
      process.env.ZCODE_CONFIG_PATH || path.join(os.homedir(), ".zcode", "cli", "config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const key = parsed?.provider?.[DEFAULT_PROVIDER_ID]?.options?.apiKey;
      if (typeof key === "string" && key.trim()) return key.trim();
    }
  } catch {
    // Ignore config read error
  }
  return undefined;
}

function createRuntimeModel(
  modelRef: ZcodeModelRef,
  captcha: ZcodeCaptcha,
  apiKey?: string
): JsonRecord {
  const generatedAt = Date.now();
  return {
    revision: `omniroute-${generatedAt}-${randomUUID()}`,
    generatedAt,
    model: modelRef,
    provider: {
      providerId: modelRef.providerId,
      kind: "anthropic",
      apiFormat: "anthropic-messages",
      source: "builtin",
      baseURL: ZCODE_ANTHROPIC_BASE_URL,
      apiKey: apiKey ? { source: "inline", value: apiKey } : undefined,
      apiKeyRequired: true,
      headers: {
        [CAPTCHA_VERIFY_PARAM_HEADER]: captcha.verifyParam,
        [CAPTCHA_VERIFY_REGION_HEADER]: captcha.region,
      },
      models: [
        {
          modelId: modelRef.modelId,
          label: modelRef.modelId,
          contextWindow: 1_000_000,
          maxOutputTokens: 131_072,
          supportsTools: true,
        },
      ],
    },
  };
}

function createCompletionWaiter(): CompletionWaiter {
  let resolve!: (result: ZcodeTurnResult | string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ZcodeTurnResult>((resolvePromise, rejectPromise) => {
    resolve = (res) => {
      if (typeof res === "string") {
        resolvePromise({ content: res });
      } else {
        resolvePromise(res);
      }
    };
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function notificationError(params: unknown): Error {
  const root = asRecord(params);
  const nestedError = asRecord(root.error);
  const source = Object.keys(nestedError).length > 0 ? nestedError : root;
  const error = new Error(extractErrorMessage(source));
  const outerCode =
    typeof source.code === "number" || typeof source.code === "string" ? source.code : undefined;
  const providerCode = extractErrorCode(source);
  if (outerCode !== undefined) Object.assign(error, { code: outerCode });
  if (providerCode !== undefined && providerCode !== outerCode)
    Object.assign(error, { providerCode });
  for (const key of ["data", "context", "error"]) {
    if (source[key] !== undefined) Object.assign(error, { [key]: source[key] });
  }
  return error;
}

export class ZcodeExecutor extends BaseExecutor {
  private static readonly activeExecutors = new Set<ZcodeExecutor>();
  private readonly options: ZcodeExecutorOptions;
  private readonly sessionCache = new Map<string, ZcodeSessionCacheEntry>();

  constructor(options: ZcodeExecutorOptions = {}) {
    super("zcode", { id: "zcode", baseUrl: ZCODE_URL, format: "openai" });
    this.options = {
      ...options,
      captchaSolver: options.captchaSolver || new ZcodeCaptchaSolver(),
    };
    ZcodeExecutor.activeExecutors.add(this);
  }

  static async closeAll(): Promise<void> {
    const all = Array.from(ZcodeExecutor.activeExecutors);
    await Promise.all(all.map((e) => e.close().catch(() => undefined)));
  }

  async close(): Promise<void> {
    ZcodeExecutor.activeExecutors.delete(this);
    const entries = Array.from(this.sessionCache.values());
    this.sessionCache.clear();
    for (const entry of entries) {
      if (entry.sessionId) {
        await entry.client
          .call("session/close", { sessionId: entry.sessionId })
          .catch(() => undefined);
      }
      await entry.client.close().catch(() => undefined);
    }
  }

  private shouldUseStdio(): boolean {
    if (process.env.ZCODE_USE_STDIO === "1") return true;
    if (
      (this.options.clientFactory || this.options.command || this.options.args) &&
      !this.options.directExecutorFactory
    ) {
      return true;
    }
    return false;
  }

  private createDirectExecutor(directOptions?: ZcodeDirectExecutorOptions): ZcodeDirectExecutor {
    if (this.options.directExecutorFactory) {
      return this.options.directExecutorFactory(directOptions);
    }
    const solver = this.options.captchaSolver as unknown as Partial<ZcodeDirectCaptchaSolver>;
    const directCaptchaSolver: ZcodeDirectCaptchaSolver | undefined =
      solver && typeof solver.solve === "function"
        ? {
            solve: (opt) => solver.solve!(opt),
            invalidate: () => (solver.invalidate ? solver.invalidate() : undefined),
          }
        : undefined;
    return new ZcodeDirectExecutor({
      ...(directCaptchaSolver ? { captchaSolver: directCaptchaSolver } : {}),
      ...directOptions,
    });
  }

  buildUrl(): string {
    return ZCODE_URL;
  }

  transformRequest(): null {
    return null;
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const resolution = resolveZcodeModel(input.model);
    if (!resolution.ok) {
      const message = "error" in resolution ? resolution.error : "Invalid ZCode model";
      return input.stream ? sseErrorResponse(400, message) : errorResponse(400, message);
    }

    if (!this.shouldUseStdio()) {
      const directOptions = buildDirectExecutorOptions(input, this.options.directExecutorOptions);
      const direct = this.createDirectExecutor(directOptions);
      if (direct) {
        let directResult: ExecutorExecuteResult | undefined;
        try {
          directResult = await direct.execute(input);
        } catch (error) {
          input.log?.warn?.(
            "ZCODE",
            `Direct API execution error: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`
          );
        }
        if (directResult && !shouldFallbackToStdio(directResult)) {
          return directResult;
        }
        if (input.signal?.aborted) {
          return (
            directResult ||
            (input.stream
              ? sseErrorResponse(499, "Request aborted")
              : errorResponse(499, "Request aborted"))
          );
        }
        input.log?.warn?.("ZCODE", "Direct API unavailable; falling back to local app-server");
      }
    }

    const body = asRecord(input.body);
    const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMsg[]) : [];
    const conversationId =
      (typeof body.conversation_id === "string" && body.conversation_id) ||
      (typeof body.chat_id === "string" && body.chat_id) ||
      hashPrompt(JSON.stringify(messages));
    const prompt = buildZcodePrompt(messages);
    input.log?.info?.("ZCODE", `local app-server turn started model=${resolution.model}`);

    try {
      const turnResult = await this.runTurn(
        resolution.model,
        prompt,
        messages,
        conversationId,
        input.signal,
        input.log
      );
      const response = input.stream
        ? sseResponse(resolution.model, turnResult.content, prompt, turnResult.usage)
        : completionResponse(resolution.model, prompt, turnResult.content, turnResult.usage);
      return {
        response,
        url: ZCODE_URL,
        headers: {},
        transformedBody: {
          ...body,
          model: resolution.model,
          prompt,
          promptLength: prompt.length,
          buffered: true,
        },
        transport: "local-zcode-app-server",
      };
    } catch (error) {
      const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
      input.log?.warn?.("ZCODE", message);
      return input.stream ? sseErrorResponse(502, message) : errorResponse(502, message);
    }
  }

  private createClient(
    captcha: ZcodeCaptcha,
    model: string,
    onNotification: ZcodeNotificationHandler
  ): ZcodeClientLike {
    let client: ZcodeClientLike | undefined;
    const apiKey = loadZcodeApiKey();
    const onRequest: ZcodeIncomingRequestHandler = async (method, params) => {
      if (method === "session/requestRuntimePreferences") {
        return { nativeSearchEnhancementsEnabled: false };
      }
      if (method === "interaction/requestProviderRuntimeHeaders") {
        const request = asRecord(params);
        const requestSessionId = typeof request.sessionId === "string" ? request.sessionId : "";
        const modelRef: ZcodeModelRef = {
          providerId: DEFAULT_PROVIDER_ID,
          modelId: officialModelId(model),
        };
        if (!client || !requestSessionId)
          throw new Error("ZCode runtime header request had no active session");
        const runtimeModel = createRuntimeModel(modelRef, captcha, apiKey);
        const updateResult = await client.call("session/updateRuntimeModelConfig", {
          sessionId: requestSessionId,
          runtimeModel,
          applyModelSelection: true,
        });
        assertRuntimeModelApplied(updateResult, runtimeModel);
        return { headersApplied: true };
      }
      return {};
    };
    const options = { onRequest, onNotification };
    if (this.options.clientFactory) {
      client = this.options.clientFactory(options);
      return client;
    }
    const command = this.options.command || defaultCommand().command;
    const args = this.options.args || defaultCommand().args;
    client = new ZcodeAppServerClient({
      command,
      args,
      cwd: this.options.cwd || process.env.ZCODE_CWD || process.cwd(),
      startupTimeoutMs:
        this.options.startupTimeoutMs ?? Number(process.env.ZCODE_STARTUP_TIMEOUT_MS || 10_000),
      requestTimeoutMs:
        this.options.requestTimeoutMs ?? Number(process.env.ZCODE_RPC_TIMEOUT_MS || 30_000),
      onRequest,
      onNotification,
    });
    return client;
  }

  private async runTurn(
    model: string,
    prompt: string,
    messages: OpenAIMsg[],
    conversationId: string,
    signal: AbortSignal | null | undefined,
    log: ExecuteInput["log"]
  ): Promise<ZcodeTurnResult> {
    for (
      let captchaRetryCount = 0;
      captchaRetryCount <= MAX_CAPTCHA_RETRIES;
      captchaRetryCount += 1
    ) {
      const captcha = await this.options.captchaSolver?.solve({
        timeoutMs:
          this.options.captchaTimeoutMs ??
          Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || DEFAULT_CAPTCHA_TIMEOUT_MS),
      });
      if (!captcha) throw new Error("ZCode captcha solver returned no token");

      const waiter = createCompletionWaiter();
      let assistantText = "";
      let completionTimer: ReturnType<typeof setTimeout> | undefined;
      const consumeNotification: ZcodeNotificationHandler = (method, params) => {
        const root = asRecord(params);
        if (method === "state.updated") {
          const patch = asRecord(root.patch);
          const candidate = extractAssistantText(patch);
          if (candidate.length > assistantText.length) assistantText = candidate;
          const status = patch.status ?? root.status;
          if ((status === "completed" || status === "idle") && assistantText.trim())
            waiter.resolve({ content: assistantText });
          if (status === "error" || status === "failed") waiter.reject(notificationError(patch));
          return;
        }
        if (method !== "session/event") return;
        const eventType = typeof root.type === "string" ? root.type : "";
        const payload = asRecord(root.payload);
        if (
          (eventType === "part.delta" || eventType === "model.streaming") &&
          typeof payload.delta === "string"
        ) {
          assistantText += payload.delta;
        }
        if (eventType === "message.upserted" && typeof payload.content === "string")
          assistantText = payload.content;
        if (eventType === "turn.completed") {
          const response = typeof payload.response === "string" ? payload.response : assistantText;
          const usageRecord = asRecord(payload.usage);
          let usage: ZcodeTurnUsage | undefined;
          const inputTokens =
            typeof usageRecord.inputTokens === "number" ? usageRecord.inputTokens : undefined;
          const outputTokens =
            typeof usageRecord.outputTokens === "number" ? usageRecord.outputTokens : undefined;
          const totalTokens =
            typeof usageRecord.totalTokens === "number" ? usageRecord.totalTokens : undefined;
          const cacheReadTokens =
            typeof usageRecord.cacheReadTokens === "number"
              ? usageRecord.cacheReadTokens
              : undefined;
          if (
            inputTokens !== undefined ||
            outputTokens !== undefined ||
            totalTokens !== undefined
          ) {
            usage = {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
              cached_tokens: cacheReadTokens,
            };
          }
          if (response.trim()) waiter.resolve({ content: response, usage });
        } else if (eventType === "turn.failed") {
          waiter.reject(notificationError(payload));
        }
      };
      const apiKey = loadZcodeApiKey();
      const cached = this.sessionCache.get(conversationId);
      if (
        cached &&
        (Date.now() - cached.lastSeen > ZCODE_SESSION_TTL_MS || cached.model !== model)
      ) {
        await cached.client
          .call("session/close", { sessionId: cached.sessionId })
          .catch(() => undefined);
        await cached.client.close().catch(() => undefined);
        this.sessionCache.delete(conversationId);
      }
      const reusable = this.sessionCache.get(conversationId);
      const notificationRouter: ZcodeNotificationHandler = (method, params) => {
        const active = this.sessionCache.get(conversationId);
        (active?.notify || consumeNotification)(method, params);
      };
      const client = reusable?.client || this.createClient(captcha, model, notificationRouter);
      if (reusable) reusable.notify = consumeNotification;
      const cwd = this.options.cwd || process.env.ZCODE_CWD || process.cwd();
      const workspace = makeWorkspace(cwd);
      const providerId = DEFAULT_PROVIDER_ID;
      let sessionId: string | undefined = reusable?.sessionId;
      const isReusable = Boolean(reusable);

      try {
        await raceAbort(client.start(), signal);
        await raceAbort(client.call("workspace/readState", { workspace }), signal);
        if (!isReusable) {
          const created = await raceAbort(
            client.call("session/create", {
              workspace,
              model: { providerId, modelId: officialModelId(model) },
            }),
            signal
          );
          sessionId = extractSessionId(created);
          if (!sessionId) throw new Error("ZCode session/create returned no sessionId");
        }

        if (!sessionId) throw new Error("ZCode session has no sessionId");
        const previousMessages = reusable?.messages || [];
        const deltaMessages = isMessagePrefix(previousMessages, messages)
          ? messages.slice(previousMessages.length)
          : messages;
        const sendPrompt = buildZcodePrompt(deltaMessages);
        const runtimeModel = createRuntimeModel(
          { providerId, modelId: officialModelId(model) },
          captcha,
          apiKey
        );
        const updateResult = await raceAbort(
          client.call("session/updateRuntimeModelConfig", {
            sessionId,
            runtimeModel,
            applyModelSelection: true,
          }),
          signal
        );
        assertRuntimeModelApplied(updateResult, runtimeModel);
        await raceAbort(
          client.call("session/subscribe", {
            sessionId,
            deliveryKind: "desktop-continuous",
          }),
          signal
        );
        await raceAbort(client.call("session/send", { sessionId, content: sendPrompt }), signal);
        this.sessionCache.set(conversationId, {
          client,
          sessionId,
          lastSeen: Date.now(),
          sentMessageCount: messages.length,
          sentPromptHash: hashPrompt(prompt),
          messages: [...messages],
          model,
          notify: consumeNotification,
        });

        const turnTimeoutMs =
          this.options.turnTimeoutMs ??
          Number(process.env.ZCODE_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS);
        completionTimer = setTimeout(
          () =>
            waiter.reject(
              new Error("ZCode turn timed out before an assistant response was available")
            ),
          Math.max(1, turnTimeoutMs)
        );
        completionTimer.unref?.();
        return await raceAbort(waiter.promise, signal);
      } catch (error) {
        const cachedEntry = this.sessionCache.get(conversationId);
        if (cachedEntry?.client === client) {
          this.sessionCache.delete(conversationId);
          await client.call("session/close", { sessionId }).catch(() => undefined);
          await client.close().catch(() => undefined);
        }
        if (!isCaptchaVerifyFailure(error) || captchaRetryCount >= MAX_CAPTCHA_RETRIES) throw error;
        continue;
      } finally {
        if (completionTimer) clearTimeout(completionTimer);
        if (!isReusable && sessionId && !this.sessionCache.has(conversationId)) {
          await client.call("session/close", { sessionId }).catch(() => undefined);
          await client
            .close()
            .catch((error) =>
              log?.debug?.("ZCODE", `app-server close failed: ${sanitizeErrorMessage(error)}`)
            );
        }
      }
    }
    throw new Error("ZCode captcha retry exhausted");
  }

  // Credentials are intentionally ignored: the local ZCode profile owns auth.
  override buildHeaders(_credentials: ProviderCredentials): Record<string, string> {
    return {};
  }
}
