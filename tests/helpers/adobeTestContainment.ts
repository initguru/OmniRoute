import cp from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
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
  /**
   * Automatically sets up a host-independent synthetic browser executable fixture
   * via OMNIROUTE_LOGIN_BROWSER_PATH in _artifacts to prevent host OS Chrome/Edge discovery.
   * Defaults to true.
   */
  setupSyntheticBrowser?: boolean;
}

export interface SyntheticBrowserFixture {
  path: string;
  ownedDir: string;
  cleanup(): void;
}

export function createSyntheticBrowserFixture(baseDir?: string): SyntheticBrowserFixture {
  const artifactsDir = baseDir ?? path.resolve(process.cwd(), "_artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const prefix = path.join(artifactsDir, "synthetic-browser-");
  const ownedDir = fs.mkdtempSync(prefix);
  const browserPath = path.join(ownedDir, "synthetic-adobe-browser.dummy");
  fs.writeFileSync(browserPath, "# dummy non-executable browser fixture\n", {
    mode: 0o644,
  });

  return {
    path: browserPath,
    ownedDir,
    cleanup() {
      try {
        if (fs.existsSync(ownedDir)) {
          fs.rmSync(ownedDir, { recursive: true, force: true });
        }
      } catch {
        /* best-effort */
      }
    },
  };
}

let activeContainment = false;

export interface AdobeTestContainmentHandle {
  counts: ContainmentCounts;
  attempts: ForbiddenAttempt[];
  syntheticBrowserPath?: string;
  syntheticBrowserFixture?: SyntheticBrowserFixture;
  getCounts(): ContainmentCounts;
  assertNoForbiddenAttempts(context?: string): void;
  restore(): void;
}

export function installAdobeTestContainment(
  options?: AdobeTestContainmentOptions
): AdobeTestContainmentHandle {
  if (activeContainment) {
    throw new Error(
      "[AdobeTestContainment] Nested containment is not allowed while another instance is active. Call restore() on the active containment handle first."
    );
  }
  activeContainment = true;

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

  // Host-independent synthetic browser discovery fixture tracking
  const shouldSetupSyntheticBrowser = options?.setupSyntheticBrowser !== false;
  let originalBrowserPathEnv: string | undefined = undefined;
  let didChangeBrowserPathEnv = false;
  let syntheticBrowserFixture: SyntheticBrowserFixture | undefined = undefined;
  let syntheticBrowserPath: string | undefined = undefined;

  // Rollback helper for cleanly reverting partial state if installation fails midway
  function rollbackPartialInstall(): void {
    activeContainment = false;

    if (didChangeBrowserRefreshEnv) {
      if (originalBrowserRefreshEnv !== undefined) {
        process.env.ADOBE_FIREFLY_BROWSER_REFRESH = originalBrowserRefreshEnv;
      } else {
        delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      }
    }

    if (didChangeBrowserPathEnv) {
      if (originalBrowserPathEnv !== undefined) {
        process.env.OMNIROUTE_LOGIN_BROWSER_PATH = originalBrowserPathEnv;
      } else {
        delete process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
      }
    }

    if (syntheticBrowserFixture) {
      try {
        syntheticBrowserFixture.cleanup();
      } catch {
        /* best effort on rollback */
      }
    }

    cp.spawn = originalCp.spawn;
    cp.spawnSync = originalCp.spawnSync;
    cp.exec = originalCp.exec;
    cp.execFile = originalCp.execFile;
    cp.execSync = originalCp.execSync;
    cp.execFileSync = originalCp.execFileSync;
    cp.fork = originalCp.fork;

    process.kill = originalProcessKill;

    http.request = originalHttp.request;
    http.get = originalHttp.get;

    https.request = originalHttps.request;
    https.get = originalHttps.get;

    net.connect = originalNet.connect;
    net.createConnection = originalNet.createConnection;
    net.Socket.prototype.connect = originalNet.socketConnect;

    tls.connect = originalTls.connect;

    try {
      syncBuiltinESMExports();
    } catch {
      /* best effort */
    }

    if (originalWebSocket !== undefined) {
      (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
    } else {
      delete (globalThis as unknown as Record<string, unknown>).WebSocket;
    }

    globalThis.fetch = originalFetch;
  }

  if (shouldSetupSyntheticBrowser) {
    originalBrowserPathEnv = process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
    try {
      syntheticBrowserFixture = createSyntheticBrowserFixture();
      syntheticBrowserPath = syntheticBrowserFixture.path;
      process.env.OMNIROUTE_LOGIN_BROWSER_PATH = syntheticBrowserPath;
      didChangeBrowserPathEnv = true;
    } catch {
      rollbackPartialInstall();
      throw new Error(
        "[AdobeTestContainment] Failed to create synthetic browser fixture: directory creation failed"
      );
    }
  }

  let trapFetch: ((...args: unknown[]) => never) | undefined = undefined;

  try {
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
  } catch (err) {
    rollbackPartialInstall();
    throw err;
  }

  let restored = false;

  function restore(): void {
    if (restored) return;
    restored = true;
    activeContainment = false;

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

    // Restore environment variable for browser refresh
    if (didChangeBrowserRefreshEnv) {
      if (originalBrowserRefreshEnv !== undefined) {
        process.env.ADOBE_FIREFLY_BROWSER_REFRESH = originalBrowserRefreshEnv;
      } else {
        delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      }
    }

    // Restore environment variable and synthetic browser fixture
    if (didChangeBrowserPathEnv) {
      if (originalBrowserPathEnv !== undefined) {
        process.env.OMNIROUTE_LOGIN_BROWSER_PATH = originalBrowserPathEnv;
      } else {
        delete process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
      }
    }
    if (syntheticBrowserFixture) {
      syntheticBrowserFixture.cleanup();
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
    syntheticBrowserPath,
    syntheticBrowserFixture,
    getCounts: () => ({ ...counts }),
    assertNoForbiddenAttempts,
    restore,
  };
}
