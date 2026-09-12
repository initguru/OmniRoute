import cp from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

export interface ContainmentCounts {
  childProcess: number;
  processKill: number;
  http: number;
  https: number;
  net: number;
  tls: number;
  webSocket: number;
  fetch: number;
  total: number;
}

export interface ForbiddenAttempt {
  type: keyof Omit<ContainmentCounts, "total">;
  target: string;
  args: unknown[];
  stack?: string;
}

export interface AdobeTestContainmentOptions {
  /**
   * Automatically sets process.env.ADOBE_FIREFLY_BROWSER_REFRESH="0"
   * and restores previous value on restore().
   */
  optOutBrowserRefresh?: boolean;
}

export interface AdobeTestContainmentHandle {
  counts: ContainmentCounts;
  attempts: ForbiddenAttempt[];
  getCounts(): ContainmentCounts;
  assertNoForbiddenAttempts(context?: string): void;
  restore(): void;
}

export function installAdobeTestContainment(
  options?: AdobeTestContainmentOptions
): AdobeTestContainmentHandle {
  const counts: ContainmentCounts = {
    childProcess: 0,
    processKill: 0,
    http: 0,
    https: 0,
    net: 0,
    tls: 0,
    webSocket: 0,
    fetch: 0,
    total: 0,
  };

  const attempts: ForbiddenAttempt[] = [];

  function recordAttempt(
    type: keyof Omit<ContainmentCounts, "total">,
    target: string,
    args: unknown[]
  ): never {
    counts[type] += 1;
    counts.total += 1;
    const err = new Error(
      `[AdobeTestContainment] Forbidden ${target} called in test environment. No real child_process, process.kill, or outbound network delegation allowed.`
    );
    attempts.push({
      type,
      target,
      args,
      stack: err.stack,
    });
    throw err;
  }

  // Preserve originals
  const originalCp = {
    spawn: cp.spawn,
    spawnSync: cp.spawnSync,
    exec: cp.exec,
    execFile: cp.execFile,
    execSync: cp.execSync,
    execFileSync: cp.execFileSync,
    fork: cp.fork,
  };

  const originalProcessKill = process.kill;

  const originalHttp = {
    request: http.request,
    get: http.get,
  };

  const originalHttps = {
    request: https.request,
    get: https.get,
  };

  const originalNet = {
    connect: net.connect,
    createConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
  };

  const originalTls = {
    connect: tls.connect,
  };

  const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
  const originalFetch = globalThis.fetch;

  // Environment opt-out tracking
  let originalBrowserRefreshEnv: string | undefined = undefined;
  let didChangeBrowserRefreshEnv = false;

  if (options?.optOutBrowserRefresh) {
    originalBrowserRefreshEnv = process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
    process.env.ADOBE_FIREFLY_BROWSER_REFRESH = "0";
    didChangeBrowserRefreshEnv = true;
  }

  // 1. child_process trap
  (cp as unknown as Record<string, unknown>).spawn = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.spawn", args);
  };
  (cp as unknown as Record<string, unknown>).spawnSync = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.spawnSync", args);
  };
  (cp as unknown as Record<string, unknown>).exec = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.exec", args);
  };
  (cp as unknown as Record<string, unknown>).execFile = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.execFile", args);
  };
  (cp as unknown as Record<string, unknown>).execSync = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.execSync", args);
  };
  (cp as unknown as Record<string, unknown>).execFileSync = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.execFileSync", args);
  };
  (cp as unknown as Record<string, unknown>).fork = function (...args: unknown[]): never {
    return recordAttempt("childProcess", "child_process.fork", args);
  };

  // 2. process.kill trap (even self pid)
  process.kill = function (...args: unknown[]): true {
    recordAttempt("processKill", "process.kill", args);
  };

  // 3. http request/get
  (http as unknown as Record<string, unknown>).request = function (...args: unknown[]): never {
    return recordAttempt("http", "http.request", args);
  };
  (http as unknown as Record<string, unknown>).get = function (...args: unknown[]): never {
    return recordAttempt("http", "http.get", args);
  };

  // 4. https request/get
  (https as unknown as Record<string, unknown>).request = function (...args: unknown[]): never {
    return recordAttempt("https", "https.request", args);
  };
  (https as unknown as Record<string, unknown>).get = function (...args: unknown[]): never {
    return recordAttempt("https", "https.get", args);
  };

  // 5. net connect/createConnection/Socket.prototype.connect
  (net as unknown as Record<string, unknown>).connect = function (...args: unknown[]): never {
    return recordAttempt("net", "net.connect", args);
  };
  (net as unknown as Record<string, unknown>).createConnection = function (
    ...args: unknown[]
  ): never {
    return recordAttempt("net", "net.createConnection", args);
  };
  (net.Socket.prototype as unknown as Record<string, unknown>).connect = function (
    ...args: unknown[]
  ): never {
    return recordAttempt("net", "net.Socket.connect", args);
  };

  // 6. tls connect
  (tls as unknown as Record<string, unknown>).connect = function (...args: unknown[]): never {
    return recordAttempt("tls", "tls.connect", args);
  };

  // Sync builtins so named ESM imports see the patched functions
  syncBuiltinESMExports();

  // 7. WebSocket trap
  function TrapWebSocket(...args: unknown[]): never {
    return recordAttempt("webSocket", "WebSocket constructor", args);
  }
  (globalThis as unknown as Record<string, unknown>).WebSocket = TrapWebSocket;

  // 8. globalThis.fetch trap
  // Wrap existing globalThis.fetch so if a test doesn't mock fetch and attempts
  // to invoke unmocked fetch, it gets trapped.
  // If the test replaces globalThis.fetch with its own mock, the test mock runs.
  // If that mock calls the wrapped native fetch, this trap catches it.
  const trapFetch = function (...args: unknown[]): never {
    return recordAttempt("fetch", "globalThis.fetch", args);
  };
  globalThis.fetch = trapFetch as unknown as typeof fetch;

  let restored = false;

  function restore(): void {
    if (restored) return;
    restored = true;

    // Restore child_process
    cp.spawn = originalCp.spawn;
    cp.spawnSync = originalCp.spawnSync;
    cp.exec = originalCp.exec;
    cp.execFile = originalCp.execFile;
    cp.execSync = originalCp.execSync;
    cp.execFileSync = originalCp.execFileSync;
    cp.fork = originalCp.fork;

    // Restore process.kill
    process.kill = originalProcessKill;

    // Restore http
    http.request = originalHttp.request;
    http.get = originalHttp.get;

    // Restore https
    https.request = originalHttps.request;
    https.get = originalHttps.get;

    // Restore net
    net.connect = originalNet.connect;
    net.createConnection = originalNet.createConnection;
    net.Socket.prototype.connect = originalNet.socketConnect;

    // Restore tls
    tls.connect = originalTls.connect;

    // Sync builtins so named ESM imports see the restored functions
    syncBuiltinESMExports();

    // Restore WebSocket
    if (originalWebSocket !== undefined) {
      (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
    } else {
      delete (globalThis as unknown as Record<string, unknown>).WebSocket;
    }

    // Restore fetch
    // Only restore if globalThis.fetch was either trapFetch or the test's mock
    if (globalThis.fetch === trapFetch || globalThis.fetch !== originalFetch) {
      globalThis.fetch = originalFetch;
    }

    // Restore environment variable
    if (didChangeBrowserRefreshEnv) {
      if (originalBrowserRefreshEnv !== undefined) {
        process.env.ADOBE_FIREFLY_BROWSER_REFRESH = originalBrowserRefreshEnv;
      } else {
        delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      }
    }
  }

  function assertNoForbiddenAttempts(context?: string): void {
    if (counts.total > 0) {
      const details = attempts
        .map((a) => `[${a.type}] ${a.target} (${JSON.stringify(a.args.slice(0, 2))})`)
        .join("; ");
      const msg = `Forbidden attempt count must be 0, got ${counts.total}: ${details}${
        context ? ` (context: ${context})` : ""
      }`;
      const failure = new Error(msg);
      failure.name = "AssertionError";
      throw failure;
    }
  }

  return {
    counts,
    attempts,
    getCounts: () => ({ ...counts }),
    assertNoForbiddenAttempts,
    restore,
  };
}
