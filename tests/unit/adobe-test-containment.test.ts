import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { kill } from "node:process";
import cp, {
  spawn,
  spawnSync,
  exec,
  execFile,
  execSync,
  execFileSync,
  fork,
} from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  installAdobeTestContainment,
  createSyntheticBrowserFixture,
  type AdobeTestContainmentHandle,
} from "../helpers/adobeTestContainment.ts";

test("adobe test containment preflight - blocks all forbidden delegate calls and records attempts", async (t) => {
  let containment: AdobeTestContainmentHandle | null = null;

  t.afterEach(() => {
    containment?.restore();
    containment = null;
  });

  await t.test("named and default child_process bindings hit traps and increment counters", () => {
    containment = installAdobeTestContainment();

    // 1. named spawn
    assert.throws(
      () => {
        spawn("echo", ["hello"]);
      },
      (err: unknown) => {
        assert.match(String(err), /Forbidden child_process\.spawn/);
        return true;
      }
    );

    // 2. default cp.spawn
    assert.throws(
      () => {
        cp.spawn("echo", ["hello"]);
      },
      (err: unknown) => {
        assert.match(String(err), /Forbidden child_process\.spawn/);
        return true;
      }
    );

    // 3. spawnSync
    assert.throws(() => spawnSync("echo", ["hi"]), /Forbidden child_process\.spawnSync/);
    assert.throws(() => cp.spawnSync("echo", ["hi"]), /Forbidden child_process\.spawnSync/);

    // 4. exec
    assert.throws(() => exec("echo hi"), /Forbidden child_process\.exec/);
    assert.throws(() => cp.exec("echo hi"), /Forbidden child_process\.exec/);

    // 5. execSync
    assert.throws(() => execSync("echo hi"), /Forbidden child_process\.execSync/);
    assert.throws(() => cp.execSync("echo hi"), /Forbidden child_process\.execSync/);

    // 6. execFile
    assert.throws(() => execFile("echo", ["hi"]), /Forbidden child_process\.execFile/);
    assert.throws(() => cp.execFile("echo", ["hi"]), /Forbidden child_process\.execFile/);

    // 7. execFileSync
    assert.throws(() => execFileSync("echo", ["hi"]), /Forbidden child_process\.execFileSync/);
    assert.throws(() => cp.execFileSync("echo", ["hi"]), /Forbidden child_process\.execFileSync/);

    // 8. fork
    assert.throws(() => fork("some-script.js"), /Forbidden child_process\.fork/);
    assert.throws(() => cp.fork("some-script.js"), /Forbidden child_process\.fork/);

    const counts = containment.getCounts();
    assert.equal(counts.childProcess, 14);
    assert.equal(counts.total, 14);
    assert.throws(() => containment?.assertNoForbiddenAttempts(), /Forbidden attempt/);
  });

  await t.test("process.kill is trapped without delegating even for self PID", () => {
    containment = installAdobeTestContainment();

    // self pid
    assert.throws(
      () => {
        process.kill(process.pid, 0);
      },
      (err: unknown) => {
        assert.match(String(err), /Forbidden process\.kill/);
        return true;
      }
    );

    // arbitrary pid
    assert.throws(
      () => {
        process.kill(999999, "SIGTERM");
      },
      (err: unknown) => {
        assert.match(String(err), /Forbidden process\.kill/);
        return true;
      }
    );

    const counts = containment.getCounts();
    assert.equal(counts.processKill, 2);
    assert.equal(counts.total, 2);
  });

  await t.test("http and https requests are trapped", () => {
    containment = installAdobeTestContainment();

    assert.throws(() => http.get("http://127.0.0.1:20128/test"), /Forbidden http\.get/);
    assert.throws(() => http.request("http://127.0.0.1:20128/test"), /Forbidden http\.request/);
    assert.throws(() => https.get("https://firefly.adobe.com"), /Forbidden https\.get/);
    assert.throws(() => https.request("https://firefly.adobe.com"), /Forbidden https\.request/);

    const counts = containment.getCounts();
    assert.equal(counts.http, 2);
    assert.equal(counts.https, 2);
    assert.equal(counts.total, 4);
  });

  await t.test("net and tls connections are trapped", () => {
    containment = installAdobeTestContainment();

    assert.throws(() => net.connect(20128, "127.0.0.1"), /Forbidden net\.connect/);
    assert.throws(
      () => net.createConnection(20128, "127.0.0.1"),
      /Forbidden net\.createConnection/
    );
    assert.throws(
      () => new net.Socket().connect(20128, "127.0.0.1"),
      /Forbidden net\.Socket\.connect/
    );
    assert.throws(() => tls.connect(443, "firefly.adobe.com"), /Forbidden tls\.connect/);

    const counts = containment.getCounts();
    assert.equal(counts.net, 3);
    assert.equal(counts.tls, 1);
    assert.equal(counts.total, 4);
  });

  await t.test("WebSocket and unmocked fetch are trapped", async () => {
    containment = installAdobeTestContainment();

    // WebSocket
    assert.throws(() => {
      new (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket(
        "ws://127.0.0.1:9222"
      );
    }, /Forbidden WebSocket constructor/);

    // Unmocked fetch
    await assert.rejects(async () => {
      await globalThis.fetch("https://firefly.adobe.com");
    }, /Forbidden globalThis\.fetch/);

    const counts = containment.getCounts();
    assert.equal(counts.webSocket, 1);
    assert.equal(counts.fetch, 1);
    assert.equal(counts.total, 2);
  });

  await t.test("mocked fetch is allowed while containment is active", async () => {
    containment = installAdobeTestContainment();

    const originalFetch = globalThis.fetch;
    let mockCalled = false;
    globalThis.fetch = async () => {
      mockCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const res = await globalThis.fetch("https://mock.example");
    assert.equal(mockCalled, true);
    assert.equal(res.status, 200);

    // No forbidden counter should have been incremented
    assert.equal(containment.getCounts().total, 0);
    containment.assertNoForbiddenAttempts();

    globalThis.fetch = originalFetch;
  });

  await t.test("restore restores original bindings and ESM named exports", () => {
    const origSpawn = cp.spawn;
    containment = installAdobeTestContainment();
    assert.notEqual(cp.spawn, origSpawn);
    assert.notEqual(spawn, origSpawn);

    containment.restore();
    containment = null;

    assert.equal(cp.spawn, origSpawn);
    assert.equal(spawn, origSpawn);
  });

  await t.test("environment opt-out helper sets and restores ADOBE_FIREFLY_BROWSER_REFRESH", () => {
    const prevEnv = process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
    try {
      delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      containment = installAdobeTestContainment({ optOutBrowserRefresh: true });
      assert.equal(process.env.ADOBE_FIREFLY_BROWSER_REFRESH, "0");

      containment.restore();
      containment = null;
      assert.equal(process.env.ADOBE_FIREFLY_BROWSER_REFRESH, undefined);
    } finally {
      if (prevEnv !== undefined) {
        process.env.ADOBE_FIREFLY_BROWSER_REFRESH = prevEnv;
      } else {
        delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      }
    }
  });

  await t.test(
    "inherited refresh=1 remains safe: containment traps spawn even if refresh=1 is explicitly set",
    async () => {
      const prevEnv = process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      try {
        process.env.ADOBE_FIREFLY_BROWSER_REFRESH = "1";
        // Even without optOutBrowserRefresh, containment traps spawn calls
        containment = installAdobeTestContainment();

        assert.throws(() => {
          spawn("google-chrome", ["--remote-debugging-port=9222"]);
        }, /Forbidden child_process\.spawn/);

        const counts = containment.getCounts();
        assert.equal(counts.childProcess, 1);
        assert.equal(counts.total, 1);
      } finally {
        if (prevEnv !== undefined) {
          process.env.ADOBE_FIREFLY_BROWSER_REFRESH = prevEnv;
        } else {
          delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
        }
      }
    }
  );

  await t.test(
    "named node:process kill is trapped after syncBuiltinESMExports and restored reliably",
    () => {
      const origProcessKill = process.kill;
      containment = installAdobeTestContainment();

      // named kill from node:process must hit the trap due to syncBuiltinESMExports
      assert.throws(() => {
        kill(process.pid, 0);
      }, /Forbidden process\.kill/);

      const counts = containment.getCounts();
      assert.equal(counts.processKill, 1);
      assert.equal(counts.total, 1);

      containment.restore();
      containment = null;

      assert.equal(process.kill, origProcessKill);
    }
  );

  await t.test(
    "setupSyntheticBrowser sets OMNIROUTE_LOGIN_BROWSER_PATH to non-executable fixture in _artifacts and restores on cleanup",
    () => {
      const prevEnv = process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
      try {
        delete process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
        containment = installAdobeTestContainment({ setupSyntheticBrowser: true });

        const configuredPath = process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
        assert.ok(configuredPath, "OMNIROUTE_LOGIN_BROWSER_PATH must be configured");
        assert.match(configuredPath, /_artifacts.*synthetic-adobe-browser\.dummy$/);
        assert.equal(fs.existsSync(configuredPath), true, "synthetic dummy file must exist");

        containment.restore();
        containment = null;

        assert.equal(
          process.env.OMNIROUTE_LOGIN_BROWSER_PATH,
          undefined,
          "OMNIROUTE_LOGIN_BROWSER_PATH must be restored to undefined"
        );
      } finally {
        if (prevEnv !== undefined) {
          process.env.OMNIROUTE_LOGIN_BROWSER_PATH = prevEnv;
        } else {
          delete process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
        }
      }
    }
  );

  await t.test(
    "nested containment is explicitly rejected while an instance is active and allowed after restore",
    () => {
      containment = installAdobeTestContainment();
      assert.throws(
        () => {
          installAdobeTestContainment();
        },
        (err: unknown) => {
          assert.match(String(err), /Nested containment is not allowed/);
          return true;
        }
      );

      containment.restore();
      containment = null;

      // After restore, a new containment can be installed cleanly
      const nextContainment = installAdobeTestContainment();
      assert.ok(nextContainment);
      nextContainment.restore();
    }
  );

  await t.test(
    "interleaved synthetic browser fixtures have distinct owned directories and isolated cleanup",
    () => {
      const artifactsDir = path.resolve(process.cwd(), "_artifacts");
      fs.mkdirSync(artifactsDir, { recursive: true });
      const unrelatedFile = path.join(artifactsDir, "test-unrelated-fixture.txt");
      fs.writeFileSync(unrelatedFile, "unrelated fixture content\n");

      try {
        const fixtureA = createSyntheticBrowserFixture();
        const fixtureB = createSyntheticBrowserFixture();

        assert.notEqual(fixtureA.path, fixtureB.path, "fixtures must have distinct paths");
        assert.notEqual(
          fixtureA.ownedDir,
          fixtureB.ownedDir,
          "fixtures must have distinct owned dirs"
        );
        assert.equal(fs.existsSync(fixtureA.path), true, "fixtureA must exist");
        assert.equal(fs.existsSync(fixtureB.path), true, "fixtureB must exist");
        assert.equal(fs.existsSync(unrelatedFile), true, "unrelated file must exist");

        // Cleanup A: B must still exist, unrelated file must not be touched
        fixtureA.cleanup();
        assert.equal(fs.existsSync(fixtureA.path), false, "fixtureA must be deleted");
        assert.equal(fs.existsSync(fixtureA.ownedDir), false, "fixtureA ownedDir must be deleted");
        assert.equal(
          fs.existsSync(fixtureB.path),
          true,
          "fixtureB must still exist after A cleanup"
        );
        assert.equal(fs.existsSync(unrelatedFile), true, "unrelated file must remain untouched");

        // Cleanup B: B is deleted, unrelated file remains
        fixtureB.cleanup();
        assert.equal(fs.existsSync(fixtureB.path), false, "fixtureB must be deleted");
        assert.equal(fs.existsSync(fixtureB.ownedDir), false, "fixtureB ownedDir must be deleted");
        assert.equal(fs.existsSync(unrelatedFile), true, "unrelated file must remain untouched");
      } finally {
        if (fs.existsSync(unrelatedFile)) {
          try {
            fs.unlinkSync(unrelatedFile);
          } catch {
            /* best effort */
          }
        }
      }
    }
  );

  await t.test(
    "failure to create synthetic browser fixture explicitly throws and cleanly rolls back partial state",
    () => {
      const prevBrowserPath = process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
      const prevRefresh = process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
      const origMkdtempSync = fs.mkdtempSync;
      const origSpawn = cp.spawn;

      try {
        process.env.OMNIROUTE_LOGIN_BROWSER_PATH = "/preserved/browser/path";
        process.env.ADOBE_FIREFLY_BROWSER_REFRESH = "1";

        // Mock fs.mkdtempSync to deterministically simulate directory creation failure
        (fs as unknown as Record<string, unknown>).mkdtempSync = () => {
          throw new Error("EACCES: permission denied, mkdtemp");
        };

        // Must explicitly throw fail-closed error with safe message without leaking internal paths
        assert.throws(
          () => {
            installAdobeTestContainment({
              optOutBrowserRefresh: true,
              setupSyntheticBrowser: true,
            });
          },
          (err: unknown) => {
            const str = String(err);
            assert.match(str, /Failed to create synthetic browser fixture/);
            // Must not leak raw system path in error message
            assert.equal(str.includes("/preserved/browser/path"), false);
            return true;
          }
        );

        // State rollback verification
        assert.equal(
          process.env.OMNIROUTE_LOGIN_BROWSER_PATH,
          "/preserved/browser/path",
          "OMNIROUTE_LOGIN_BROWSER_PATH must be rolled back"
        );
        assert.equal(
          process.env.ADOBE_FIREFLY_BROWSER_REFRESH,
          "1",
          "ADOBE_FIREFLY_BROWSER_REFRESH must be rolled back"
        );
        assert.equal(cp.spawn, origSpawn, "child_process bindings must remain unpatched");

        // Restore mkdtempSync so we can test clean re-installation
        fs.mkdtempSync = origMkdtempSync;

        // Verify activeContainment was rolled back, allowing clean re-installation
        const cleanHandle = installAdobeTestContainment({
          optOutBrowserRefresh: true,
          setupSyntheticBrowser: true,
        });
        assert.ok(cleanHandle);
        cleanHandle.restore();
      } finally {
        fs.mkdtempSync = origMkdtempSync;
        if (prevBrowserPath !== undefined) {
          process.env.OMNIROUTE_LOGIN_BROWSER_PATH = prevBrowserPath;
        } else {
          delete process.env.OMNIROUTE_LOGIN_BROWSER_PATH;
        }
        if (prevRefresh !== undefined) {
          process.env.ADOBE_FIREFLY_BROWSER_REFRESH = prevRefresh;
        } else {
          delete process.env.ADOBE_FIREFLY_BROWSER_REFRESH;
        }
      }
    }
  );
});
