import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = path.join(ROOT, "scripts", "deploy", "pm2_gate_20129.sh");

describe("pm2_gate_20129.sh contract and behavior", () => {
  it("script exists, is executable, and passes bash syntax check", () => {
    assert.ok(fs.existsSync(SCRIPT_PATH), `Script missing at ${SCRIPT_PATH}`);
    const stats = fs.statSync(SCRIPT_PATH);
    assert.ok((stats.mode & 0o111) !== 0, "Script is not executable (chmod +x required)");

    const syntaxCheck = spawnSync("bash", ["-n", SCRIPT_PATH], { encoding: "utf8" });
    assert.equal(syntaxCheck.status, 0, `bash -n syntax check failed: ${syntaxCheck.stderr}`);
  });

  it("satisfies strict structural and safety contracts inherited from pm2_reregister.sh", () => {
    assert.ok(fs.existsSync(SCRIPT_PATH), "Script must exist to verify structural contract");
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");

    // Shebang and strict mode
    assert.ok(content.startsWith("#!/usr/bin/env bash"), "Missing bash shebang");
    assert.ok(content.includes("set -euo pipefail"), "Missing 'set -euo pipefail'");

    // Source ~/.bashrc
    assert.match(
      content,
      /\b(source|\.)\s+["']?\$\{HOME\}\/\.bashrc["']?/,
      "Must source ~/.bashrc"
    );

    // Path resolution matching pm2_reregister.sh
    assert.ok(content.includes("STANDALONE_ROOT="), "Must define STANDALONE_ROOT");
    assert.ok(content.includes("SERVER_ENTRY="), "Must define SERVER_ENTRY");
    assert.ok(content.includes(".build/next/standalone"), "Must resolve .build/next/standalone");
    assert.ok(content.includes("run-standalone.mjs"), "Must target run-standalone.mjs");

    // Preflight tool checks
    assert.ok(content.includes("command -v node"), "Must check node availability");
    assert.ok(content.includes("command -v pm2"), "Must check pm2 availability");
    assert.ok(content.includes("command -v sqlite3"), "Must check sqlite3 availability");

    // App name & isolation rules:
    // MUST name candidate app omniroute-gate-20129
    assert.ok(
      content.includes("omniroute-gate-20129"),
      "Must define app name omniroute-gate-20129"
    );
    // CRITICAL: NEVER touch production omniroute-server
    assert.ok(
      !content.includes("omniroute-server"),
      "CRITICAL VIOLATION: Script must NEVER touch production 'omniroute-server'!"
    );
    // CRITICAL: NEVER persist gate process across PM2 reboots
    assert.ok(
      !content.includes("pm2 save"),
      "CRITICAL VIOLATION: Script must NEVER run 'pm2 save' for temporary gate app!"
    );

    // Database snapshotting via sqlite3 online backup
    assert.ok(
      content.includes("sqlite3") && content.includes(".backup"),
      "Must use sqlite3 online backup (.backup) for atomic snapshot"
    );

    // Env and secret preservation
    assert.ok(content.includes("server.env"), "Must preserve/copy server.env into gate DATA_DIR");
    assert.ok(content.includes(".env"), "Must preserve/copy .env into gate DATA_DIR");

    // Port and background services isolation
    assert.ok(content.includes("PORT=20129"), "Must set PORT=20129");
    assert.ok(content.includes("DASHBOARD_PORT=20129"), "Must set DASHBOARD_PORT=20129");
    assert.ok(content.includes("API_PORT=20129"), "Must set API_PORT=20129");
    assert.ok(content.includes("OMNIROUTE_PORT=20129"), "Must set OMNIROUTE_PORT=20129");
    assert.ok(content.includes("OMNIROUTE_PUBLIC_BASE_URL="), "Must set OMNIROUTE_PUBLIC_BASE_URL");
    assert.ok(content.includes("LIVE_WS_PORT=20133"), "Must set LIVE_WS_PORT=20133");
    assert.ok(
      content.includes("OMNIROUTE_ENABLE_LIVE_WS=0"),
      "Must set OMNIROUTE_ENABLE_LIVE_WS=0"
    );
    assert.ok(
      content.includes("OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1"),
      "Must disable background services (OMNIROUTE_DISABLE_BACKGROUND_SERVICES=1)"
    );
    assert.ok(
      content.includes("OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=true"),
      "Must disable credential health check"
    );
    assert.ok(
      content.includes("DISABLE_SQLITE_AUTO_BACKUP=true"),
      "Must disable SQLite auto backup"
    );
    assert.ok(
      content.includes("OMNIROUTE_WAL_TRUNCATE_INTERVAL_MS=0"),
      "Must disable WAL truncate interval"
    );
    assert.ok(content.includes("PROXY_HEALTH_ENABLED=false"), "Must disable proxy health check");

    // Node args & update env
    assert.ok(
      content.includes('--node-args="--max-http-header-size=65536"') ||
        content.includes("--node-args='--max-http-header-size=65536'"),
      "Must pass --max-http-header-size=65536 to node args"
    );
    assert.ok(content.includes("--update-env"), "Must pass --update-env to pm2 start");

    // Subcommands handling
    assert.match(content, /\bstart\b/, "Must handle 'start' subcommand");
    assert.match(content, /\bstop\b/, "Must handle 'stop' subcommand");
    assert.match(content, /\bstatus\b/, "Must handle 'status' subcommand");
    assert.match(content, /\blogs\b/, "Must handle 'logs' subcommand");
    assert.ok(content.includes("--clean"), "Must support '--clean' flag on stop");

    // Health poll
    assert.ok(
      content.includes("http://127.0.0.1:20129/api/health"),
      "Must poll /api/health on port 20129"
    );
  });

  it("handles --help and displays usage information", () => {
    const result = spawnSync("bash", [SCRIPT_PATH, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, `--help exited non-zero: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/i, "Usage banner not found");
    assert.match(result.stdout, /start/i, "start command not listed in help");
    assert.match(result.stdout, /stop/i, "stop command not listed in help");
    assert.match(result.stdout, /status/i, "status command not listed in help");
    assert.match(result.stdout, /logs/i, "logs command not listed in help");
    assert.match(result.stdout, /--clean/i, "--clean flag not listed in help");
  });

  it("rejects unknown subcommands with an error and non-zero exit code", () => {
    const result = spawnSync("bash", [SCRIPT_PATH, "invalid-command-xyz"], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "Unknown command should fail");
    assert.match(
      result.stderr + result.stdout,
      /unknown command|invalid-command-xyz/i,
      "Expected error message for unknown command"
    );
  });

  it("subcommand execution simulation with mock PM2", () => {
    // Create temporary directory with mock binaries to test stop, status, logs execution safely
    const tmpDir = fs.mkdtempSync(path.join(ROOT, "_artifacts", "test_gate_mock_"));
    const mockBinDir = path.join(tmpDir, "bin");
    const invocationsLog = path.join(tmpDir, "pm2_invocations.log");
    fs.mkdirSync(mockBinDir, { recursive: true });

    try {
      // Mock pm2 binary that logs all calls
      const mockPm2 = path.join(mockBinDir, "pm2");
      fs.writeFileSync(
        mockPm2,
        `#!/usr/bin/env bash\necho "pm2 $@" >> "${invocationsLog}"\nexit 0\n`,
        { mode: 0o755 }
      );

      const env = {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
      };

      // Test stop subcommand
      const stopResult = spawnSync("bash", [SCRIPT_PATH, "stop"], {
        encoding: "utf8",
        env,
      });
      assert.equal(stopResult.status, 0, `stop command failed: ${stopResult.stderr}`);
      assert.match(stopResult.stdout, /omniroute-gate-20129 stopped/i);

      // Verify pm2 was invoked to delete omniroute-gate-20129
      const logsAfterStop = fs.readFileSync(invocationsLog, "utf8");
      assert.match(logsAfterStop, /pm2 delete omniroute-gate-20129/);

      // Test stop --clean cleans gate directory
      const gateDataDir = path.join(ROOT, "_artifacts", "gate_20129_data");
      fs.mkdirSync(gateDataDir, { recursive: true });
      fs.writeFileSync(path.join(gateDataDir, "dummy.txt"), "test");
      assert.ok(fs.existsSync(gateDataDir), "gateDataDir should exist before --clean");

      const stopCleanResult = spawnSync("bash", [SCRIPT_PATH, "stop", "--clean"], {
        encoding: "utf8",
        env,
      });
      assert.equal(stopCleanResult.status, 0, `stop --clean failed: ${stopCleanResult.stderr}`);
      assert.ok(!fs.existsSync(gateDataDir), "gateDataDir should have been cleaned by --clean");

      // Test status subcommand
      const statusResult = spawnSync("bash", [SCRIPT_PATH, "status"], {
        encoding: "utf8",
        env,
      });
      assert.equal(statusResult.status, 0, `status command failed: ${statusResult.stderr}`);
      const logsAfterStatus = fs.readFileSync(invocationsLog, "utf8");
      assert.match(logsAfterStatus, /pm2 status omniroute-gate-20129/);

      // Test logs subcommand
      const logsResult = spawnSync("bash", [SCRIPT_PATH, "logs", "--nostream"], {
        encoding: "utf8",
        env,
      });
      assert.equal(logsResult.status, 0, `logs command failed: ${logsResult.stderr}`);
      const logsAfterLogs = fs.readFileSync(invocationsLog, "utf8");
      assert.match(logsAfterLogs, /pm2 logs omniroute-gate-20129 --lines 50/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
