import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface SyntheticProcess {
  alive: boolean;
  signals: Array<string | number>;
}

class SyntheticProcessManager {
  public processes = new Map<number, SyntheticProcess>();
  public calls = {
    isPidRunning: [] as number[],
    processKill: [] as Array<{ pid: number; signal?: string | number }>,
    sleep: [] as number[],
    stopProcessGracefully: [] as Array<{ pid: number; timeoutMs?: number }>,
    killAllSubprocesses: 0,
    cleanupPidFile: [] as string[],
    readPidFile: [] as string[],
    killByPort: [] as Array<{ port: number; deps?: unknown }>,
    execFileAsync: [] as Array<{ file: string; args?: readonly string[] }>,
  };

  addProcess(pid: number, alive = true) {
    this.processes.set(pid, { alive, signals: [] });
  }

  isPidRunning(pid: number): boolean {
    this.calls.isPidRunning.push(pid);
    return this.processes.get(pid)?.alive ?? false;
  }

  processKill(pid: number, signal?: string | number): void {
    this.calls.processKill.push({ pid, signal });
    const proc = this.processes.get(pid);
    if (proc) {
      if (signal !== undefined) proc.signals.push(signal);
      if (signal === "SIGKILL") {
        proc.alive = false;
      }
    }
  }

  async sleep(ms: number): Promise<void> {
    this.calls.sleep.push(ms);
  }

  async stopProcessGracefully(opts: {
    pid: number;
    timeoutMs?: number;
    platform?: string;
    [key: string]: unknown;
  }): Promise<void> {
    const record: { pid: number; timeoutMs?: number; platform?: string } = {
      pid: opts.pid,
      timeoutMs: opts.timeoutMs,
    };
    if (opts.platform !== undefined) {
      record.platform = opts.platform;
    }
    this.calls.stopProcessGracefully.push(record);
    const proc = this.processes.get(opts.pid);
    if (proc) {
      proc.alive = false;
    }
  }

  killAllSubprocesses(): void {
    this.calls.killAllSubprocesses++;
  }

  cleanupPidFile(service: string): void {
    this.calls.cleanupPidFile.push(service);
  }

  readPidFile(service: string): number | null {
    this.calls.readPidFile.push(service);
    return null;
  }

  async killByPort(port: number, deps?: unknown): Promise<boolean> {
    this.calls.killByPort.push({ port, deps });
    return true;
  }
}

interface RunContext {
  dataDir: string;
  forbiddenKills: Array<{ pid: number; signal?: string | number }>;
  synthetic: SyntheticProcessManager;
}

async function withSafeEnvironment(fn: (ctx: RunContext) => Promise<void>) {
  const originalDataDir = process.env.DATA_DIR;
  const originalPath = process.env.PATH;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalProcessKill = process.kill;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cli-stop-"));
  const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-empty-bin-"));

  const forbiddenKills: Array<{ pid: number; signal?: string | number }> = [];
  const synthetic = new SyntheticProcessManager();

  // Intercept process.kill unconditionally — NEVER delegate to originalProcessKill
  process.kill = ((pid: number, signal?: string | number) => {
    forbiddenKills.push({ pid, signal });
    throw new Error(`UNCONTAINED_PROCESS_KILL: attempt to signal pid ${pid} with ${signal}`);
  }) as typeof process.kill;

  process.env.DATA_DIR = dataDir;
  process.env.PATH = emptyBinDir; // Suppresses real lsof and netstat execution on host
  globalThis.fetch = (async () => {
    throw new Error("server offline");
  }) as typeof fetch;

  console.log = () => {};
  console.error = () => {};

  try {
    await fn({ dataDir, forbiddenKills, synthetic });
    assert.deepEqual(forbiddenKills, [], "Host process.kill was invoked during test!");
  } finally {
    process.kill = originalProcessKill;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;

    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(emptyBinDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("stop calls killByPort and cleanup when no PID file exists", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      {},
      {
        killByPort: (port, deps) => synthetic.killByPort(port, deps),
        cleanupPidFile: (service) => synthetic.cleanupPidFile(service),
        killAllSubprocesses: () => synthetic.killAllSubprocesses(),
      }
    );
    assert.equal(result, 0);
    assert.deepEqual(
      synthetic.calls.killByPort.map((c) => c.port),
      [20128]
    );
    assert.deepEqual(synthetic.calls.cleanupPidFile, ["server", "supervisor"]);
    assert.equal(synthetic.calls.killAllSubprocesses, 1);
  });
});

test("stop does not port-fallback when PID file exists at server/.pid but process is stale", async () => {
  await withSafeEnvironment(async ({ dataDir, synthetic }) => {
    const serverDir = path.join(dataDir, "server");
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, ".pid"), "12345", "utf8");

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      {},
      {
        isPidRunning: (pid) => synthetic.isPidRunning(pid),
        killByPort: (port, deps) => synthetic.killByPort(port, deps),
        cleanupPidFile: (service) => synthetic.cleanupPidFile(service),
      }
    );
    assert.equal(result, 0);
    assert.equal(synthetic.calls.killByPort.length, 0, "Must not port-fallback on stale PID");
    assert.deepEqual(synthetic.calls.isPidRunning, [12345]);
  });
});

test("stop terminates supervisor, gracefully stops server, and cleans up when running", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(1001, true);
    synthetic.addProcess(2002, true);

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      {},
      {
        readPidFile: (service) =>
          service === "server" ? 1001 : service === "supervisor" ? 2002 : null,
        isPidRunning: (pid) => synthetic.isPidRunning(pid),
        processKill: (pid, sig) => synthetic.processKill(pid, sig),
        sleep: (ms) => synthetic.sleep(ms),
        stopProcessGracefully: (opts) => synthetic.stopProcessGracefully(opts),
        killAllSubprocesses: () => synthetic.killAllSubprocesses(),
        cleanupPidFile: (service) => synthetic.cleanupPidFile(service),
      }
    );

    assert.equal(result, 0);
    assert.deepEqual(synthetic.calls.processKill, [{ pid: 2002, signal: "SIGTERM" }]);
    assert.deepEqual(synthetic.calls.sleep, [300]);
    assert.deepEqual(synthetic.calls.stopProcessGracefully, [{ pid: 1001, timeoutMs: 5000 }]);
    assert.equal(synthetic.calls.killAllSubprocesses, 1);
    assert.deepEqual(synthetic.calls.cleanupPidFile, ["server", "supervisor"]);
  });
});

test("stop terminates running server without supervisor", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(1001, true);

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      {},
      {
        readPidFile: (service) => (service === "server" ? 1001 : null),
        isPidRunning: (pid) => synthetic.isPidRunning(pid),
        processKill: (pid, sig) => synthetic.processKill(pid, sig),
        sleep: (ms) => synthetic.sleep(ms),
        stopProcessGracefully: (opts) => synthetic.stopProcessGracefully(opts),
        killAllSubprocesses: () => synthetic.killAllSubprocesses(),
        cleanupPidFile: (service) => synthetic.cleanupPidFile(service),
      }
    );

    assert.equal(result, 0);
    assert.deepEqual(synthetic.calls.processKill, []);
    assert.deepEqual(synthetic.calls.stopProcessGracefully, [{ pid: 1001, timeoutMs: 5000 }]);
    assert.equal(synthetic.calls.killAllSubprocesses, 1);
    assert.deepEqual(synthetic.calls.cleanupPidFile, ["server", "supervisor"]);
  });
});

test("stop terminates running supervisor during port fallback", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(2002, true);

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      { port: 20128 },
      {
        readPidFile: (service) => (service === "supervisor" ? 2002 : null),
        isPidRunning: (pid) => synthetic.isPidRunning(pid),
        processKill: (pid, sig) => synthetic.processKill(pid, sig),
        killByPort: (port, deps) => synthetic.killByPort(port, deps),
        killAllSubprocesses: () => synthetic.killAllSubprocesses(),
        cleanupPidFile: (service) => synthetic.cleanupPidFile(service),
      }
    );

    assert.equal(result, 0);
    assert.deepEqual(synthetic.calls.processKill, [{ pid: 2002, signal: "SIGTERM" }]);
    assert.deepEqual(
      synthetic.calls.killByPort.map((c) => c.port),
      [20128]
    );
    assert.equal(synthetic.calls.killAllSubprocesses, 1);
    assert.deepEqual(synthetic.calls.cleanupPidFile, ["server", "supervisor"]);
  });
});

test("stop returns 1 when stopProcessGracefully throws", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(1001, true);

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      {},
      {
        readPidFile: (service) => (service === "server" ? 1001 : null),
        isPidRunning: (pid) => synthetic.isPidRunning(pid),
        stopProcessGracefully: async () => {
          throw new Error("termination failure");
        },
      }
    );

    assert.equal(result, 1);
  });
});

test("killByPort uses injected execFileAsync, processKill, isPidRunning and sleep", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(5555, true);
    const killSignals: Array<{ pid: number; signal: string }> = [];

    const { killByPort } = await import("../../bin/cli/commands/stop.mjs");
    const freed = await killByPort(20128, {
      execFileAsync: async (cmd: string, args?: readonly string[]) => {
        synthetic.calls.execFileAsync.push({ file: cmd, args });
        return { stdout: "5555\n", stderr: "" };
      },
      processKill: (pid: number, signal: string) => {
        killSignals.push({ pid, signal });
      },
      isPidRunning: (_pid: number) => {
        const killCount = killSignals.filter((s) => s.signal === "SIGKILL").length;
        return killCount === 0;
      },
      sleep: async (ms: number) => {
        synthetic.sleep(ms);
      },
      platform: "darwin",
    });

    assert.equal(freed, true);
    assert.deepEqual(killSignals, [
      { pid: 5555, signal: "SIGTERM" },
      { pid: 5555, signal: "SIGKILL" },
    ]);
  });
});

test("killByPort returns true when no process is listening on port", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    const { killByPort } = await import("../../bin/cli/commands/stop.mjs");
    const freed = await killByPort(20128, {
      execFileAsync: async () => {
        return { stdout: "", stderr: "" };
      },
      processKill: (pid: number, signal: string) => {
        synthetic.processKill(pid, signal);
      },
      isPidRunning: (pid: number) => synthetic.isPidRunning(pid),
      sleep: async (ms: number) => synthetic.sleep(ms),
      platform: "darwin",
    });

    assert.equal(freed, true);
    assert.equal(synthetic.calls.processKill.length, 0);
  });
});

test("runStopCommand forwards discovery and signaling deps to killByPort when killByPort is not overridden", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(7777, true);
    const execCalls: string[] = [];
    const killCalls: Array<{ pid: number; signal: string }> = [];

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      { port: 20128 },
      {
        readPidFile: () => null,
        execFileAsync: async (cmd: string, args?: readonly string[]) => {
          execCalls.push(`${cmd} ${args?.join(" ")}`);
          return { stdout: "7777\n", stderr: "" };
        },
        processKill: (pid: number, signal: string) => {
          killCalls.push({ pid, signal });
        },
        isPidRunning: () => false,
        sleep: async () => {},
        cleanupPidFile: () => {},
        killAllSubprocesses: () => {},
        platform: "darwin",
      }
    );

    assert.equal(result, 0);
    assert.deepEqual(execCalls, ["lsof -ti :20128"]);
    assert.deepEqual(killCalls, [{ pid: 7777, signal: "SIGTERM" }]);
  });
});

test("stop forwards platform to stopProcessGracefully (e.g. win32)", async () => {
  await withSafeEnvironment(async ({ synthetic }) => {
    synthetic.addProcess(1001, true);

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    const result = await runStopCommand(
      {},
      {
        readPidFile: (service) => (service === "server" ? 1001 : null),
        isPidRunning: (pid) => synthetic.isPidRunning(pid),
        processKill: (pid, sig) => synthetic.processKill(pid, sig),
        sleep: (ms) => synthetic.sleep(ms),
        stopProcessGracefully: (opts) => synthetic.stopProcessGracefully(opts),
        killAllSubprocesses: () => synthetic.killAllSubprocesses(),
        cleanupPidFile: (service) => synthetic.cleanupPidFile(service),
        platform: "win32",
      }
    );

    assert.equal(result, 0);
    assert.deepEqual(synthetic.calls.stopProcessGracefully, [
      { pid: 1001, timeoutMs: 5000, platform: "win32" },
    ]);
  });
});

test("runStopCommand ignores opts.deps and only respects second argument deps", async () => {
  await withSafeEnvironment(async () => {
    let optsDepsKillCalled = false;

    const { runStopCommand } = await import("../../bin/cli/commands/stop.mjs");
    await runStopCommand({
      deps: {
        killByPort: async () => {
          optsDepsKillCalled = true;
          return true;
        },
      },
    } as unknown as Record<string, unknown>);

    assert.equal(optsDepsKillCalled, false, "opts.deps must be ignored");
  });
});
