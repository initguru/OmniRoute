import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;
export type ZcodeRpcId = string | number;

export interface ZcodeAppServerClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  onRequest?: ZcodeIncomingRequestHandler;
  onNotification?: ZcodeNotificationHandler;
}

export interface ZcodeClientLike {
  start(): Promise<void>;
  call(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export type ZcodeIncomingRequestHandler = (
  method: string,
  params: unknown,
  id: ZcodeRpcId
) => unknown | Promise<unknown>;

export type ZcodeNotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function idKey(id: ZcodeRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function errorFromPayload(payload: unknown, fallback: string): Error {
  const record = payload && typeof payload === "object" ? payload as JsonRecord : {};
  const message = typeof record.message === "string" ? record.message : fallback;
  const error = new Error(message);
  const visited = new Set<object>();
  const findCode = (value: unknown, depth: number): number | string | undefined => {
    if (!value || typeof value !== "object" || depth > 8) return undefined;
    if (visited.has(value)) return undefined;
    visited.add(value);
    const nested = value as JsonRecord;
    const directCodes = [nested.code, nested.providerCode];
    for (const code of directCodes) {
      if (code === 3007 || code === "3007" || code === "CAPTCHA_VERIFY_FAILED") return code;
    }
    let firstCode: number | string | undefined;
    for (const code of directCodes) {
      if (firstCode === undefined && (typeof code === "number" || typeof code === "string")) {
        firstCode = code;
      }
    }
    for (const child of Object.values(nested)) {
      const code = findCode(child, depth + 1);
      if (code === 3007 || code === "3007" || code === "CAPTCHA_VERIFY_FAILED") return code;
      if (firstCode === undefined && code !== undefined) firstCode = code;
    }
    for (const code of directCodes) {
      if (typeof code === "number" || typeof code === "string") return code;
    }
    return firstCode;
  };
  const outerCode = typeof record.code === "number" || typeof record.code === "string" ? record.code : undefined;
  const nestedCodes = ["error", "data", "context", "payload", "details", "cause"]
    .map((key) => findCode(record[key], 0))
    .filter((candidate): candidate is number | string => candidate !== undefined);
  const nestedCode = nestedCodes.find((candidate) =>
    candidate === 3007 || candidate === "3007" || candidate === "CAPTCHA_VERIFY_FAILED"
  ) ?? nestedCodes[0];
  if (outerCode !== undefined) Object.assign(error, { code: outerCode });
  if (nestedCode !== undefined && nestedCode !== outerCode) Object.assign(error, { providerCode: nestedCode });
  for (const key of ["data", "context"]) {
    if (record[key] !== undefined) Object.assign(error, { [key]: record[key] });
  }
  return error;
}

/**
 * Local stdio client for the official ZCode app-server protocol.
 *
 * ZCode speaks newline-delimited JSON. Requests and responses are JSON
 * objects keyed by id; notifications and server-initiated requests are also
 * JSON objects and never carry a JSON-RPC `jsonrpc` field.
 */
export class ZcodeAppServerClient implements ZcodeClientLike {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onRequest?: ZcodeIncomingRequestHandler;
  private readonly onNotification?: ZcodeNotificationHandler;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ready = false;
  private startPromise?: Promise<void>;
  private serverReady?: () => void;
  private serverReadyError?: (error: Error) => void;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: ZcodeAppServerClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.ready = false;
    child.stdin.on("error", () => {
      // EPIPE is expected when timeout/abort closes an already-exited runtime.
    });

    let settled = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.serverReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.serverReadyError = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", () => {
      // Runtime diagnostics can contain provider credentials; never forward them.
    });
    child.once("spawn", () => this.serverReady?.());
    child.on("error", (error) => {
      this.serverReadyError?.(error);
      this.rejectPending(error);
    });
    child.on("exit", (code, signal) => {
      const error = new Error(`ZCode app-server exited: ${code ?? signal ?? "unknown"}`);
      this.ready = false;
      this.serverReadyError?.(error);
      this.rejectPending(error);
      if (this.child === child) this.child = undefined;
    });

    try {
      await this.withTimeout(readyPromise, this.startupTimeoutMs, "ZCode app-server startup timed out");
      this.ready = true;
    } catch (error) {
      await this.disposeChild(child);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      this.serverReady = undefined;
      this.serverReadyError = undefined;
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer = this.stdoutBuffer.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.byteLength > MAX_LINE_BYTES) {
          const error = new Error("ZCode NDJSON message exceeds the configured safety limit");
          this.rejectPending(error);
          this.serverReadyError?.(error);
        }
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > MAX_LINE_BYTES) {
        const error = new Error("ZCode NDJSON message exceeds the configured safety limit");
        this.rejectPending(error);
        this.serverReadyError?.(error);
        continue;
      }
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        const error = new Error("Invalid ZCode NDJSON message");
        this.rejectPending(error);
        this.serverReadyError?.(error);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as JsonRecord;
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = message.id;
    if (hasId && (typeof id === "string" || typeof id === "number")) {
      if (typeof message.method === "string") {
        this.handleServerRequest(id, message.method, message.params);
        return;
      }
      const request = this.pending.get(idKey(id));
      if (!request) return;
      this.pending.delete(idKey(id));
      clearTimeout(request.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        request.reject(errorFromPayload(message.error, "ZCode app-server request failed"));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      try {
        this.onNotification?.(message.method, message.params);
      } catch {
        // A consumer notification callback must not tear down the transport.
      }
    }
  }

  private handleServerRequest(id: ZcodeRpcId, method: string, params: unknown): void {
    const child = this.child;
    if (!child) return;
    Promise.resolve(this.onRequest?.(method, params, id) ?? {})
      .then((result) => {
        if (this.child !== child || child.exitCode !== null || child.signalCode !== null) return;
        this.writeMessage({ id, result: result === undefined ? null : result });
      })
      .catch((error) => {
        if (this.child !== child || child.exitCode !== null || child.signalCode !== null) return;
        const record = error && typeof error === "object" ? error as JsonRecord : {};
        this.writeMessage({
          id,
          error: {
            code: typeof record.code === "number" ? record.code : -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }

  private writeMessage(message: JsonRecord): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child || !this.ready) throw new Error("ZCode app-server is not ready");
    const requestId = this.nextRequestId++;
    const key = idKey(requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`ZCode app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.writeMessage({ id: requestId, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.ready = false;
    this.child = undefined;
    this.serverReadyError?.(new Error("ZCode app-server closed"));
    this.rejectPending(new Error("ZCode app-server closed"));
    if (child) await this.disposeChild(child);
  }

  private rejectPending(error: Error): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  private async disposeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let resolveClosed: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveClosed = resolve;
      child.once("close", resolve);
    });
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed stdin.
    }
    if (!child.killed) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1500);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    }
    resolveClosed?.();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
