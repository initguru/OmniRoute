import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../../src/lib/db/cleanup.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const enabled of [undefined, "0", "1"]) {
  test(`cleanup deletes rows but only vacuums with explicit opt-in (${enabled})`, async () => {
    const callbacks = [];
    const deletes = [];
    const maintenance = [];
    const db = {
      prepare(sql) {
        return {
          run() {
            deletes.push(sql);
            return { changes: 1 };
          },
        };
      },
      exec(sql) {
        maintenance.push(sql);
      },
    };
    const exports = {};
    runInNewContext(compiled, {
      exports,
      require(name) {
        if (name === "./core") return { getDbInstance: () => db };
        if (name === "./databaseSettings") {
          return {
            getUserDatabaseSettings: () => ({
              retention: { autoCleanupEnabled: false, callLogs: 90 },
            }),
          };
        }
        return {};
      },
      process: { env: { OMNIROUTE_AUTO_VACUUM: enabled } },
      console: { log() {}, warn() {}, error() {} },
      setTimeout(callback) {
        callbacks.push(callback);
        return 1;
      },
      setInterval(callback) {
        callbacks.push(callback);
        return 2;
      },
      clearInterval() {},
    });
    exports.startCleanupScheduler();
    assert.equal(callbacks.length, 2);
    for (const callback of callbacks) await callback();
    assert.equal(deletes.length, 2, "startup and periodic cleanup still delete expired proxy logs");
    assert.ok(deletes.every((sql) => sql.startsWith("DELETE FROM proxy_logs")));
    assert.deepEqual(maintenance, enabled === "1" ? ["VACUUM", "VACUUM"] : []);
    exports.stopCleanupScheduler();
  });
}
