import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ZcodeCaptchaSolver,
  type ZcodeCaptchaPage,
  type ZcodeCaptchaSolverDependencies,
} from "../../../open-sse/services/zcodeCaptchaSolver.ts";

const VALID_TOKEN = "v".repeat(280);

type Harness = {
  deps: ZcodeCaptchaSolverDependencies;
  acquired: Array<{ key: string; options: Record<string, unknown> }>;
  opened: number;
  closed: number;
  scripts: string[];
};

function createHarness(
  tokens: string[] = [VALID_TOKEN],
  verificationError: string | null = null
): Harness {
  const acquired: Harness["acquired"] = [];
  const scripts: string[] = [];
  let opened = 0;
  let closed = 0;

  const deps = {
    acquireBrowserContext: async (key: string, options: Record<string, unknown>) => {
      acquired.push({ key, options });
      return { id: key };
    },
    openPage: async (): Promise<ZcodeCaptchaPage> => {
      const token = tokens[opened] ?? VALID_TOKEN;
      opened += 1;
      return {
        async addScriptTag(options: { url: string }) {
          scripts.push(options.url);
        },
        async evaluate<T>(fn: unknown): Promise<T> {
          const serialized = String(fn);
          if (serialized.includes("CAPTCHA_STATE_KEY") || serialized.includes("asErrorMessage")) {
            throw new Error("page.evaluate callback captured a Node-only helper");
          }
          // The first evaluation installs the DOM/config and starts the captcha;
          // the final evaluation reads the state after waitForFunction resolves.
          if (String(fn).includes("return value")) {
            return { verifyParam: token, error: verificationError } as T;
          }
          return undefined as T;
        },
        async waitForFunction<T>(): Promise<T> {
          return {} as T;
        },
        async close() {
          closed += 1;
        },
      };
    },
  } as unknown as ZcodeCaptchaSolverDependencies;

  return {
    deps,
    acquired,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    scripts,
  } as Harness;
}

describe("ZcodeCaptchaSolver", () => {
  it("acquires a headed context, returns a fresh verify param, and closes the page", async () => {
    const harness = createHarness();
    const solver = new ZcodeCaptchaSolver(harness.deps);

    const result = await solver.solve({ timeoutMs: 1_000 });

    assert.deepEqual(result, { verifyParam: VALID_TOKEN, region: "sgp" });
    assert.equal(harness.acquired.length, 1);
    assert.equal(harness.acquired[0]?.key, "zcode-captcha");
    assert.equal(harness.acquired[0]?.options.headless, false);
    assert.equal(harness.scripts[0], "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js");
    assert.equal(harness.closed, 1);
  });

  it("creates a new page and obtains a new token for every solve call", async () => {
    const first = "a".repeat(280);
    const second = "b".repeat(280);
    const harness = createHarness([first, second]);
    const solver = new ZcodeCaptchaSolver(harness.deps);

    assert.deepEqual(await solver.solve(), { verifyParam: first, region: "sgp" });
    assert.deepEqual(await solver.solve(), { verifyParam: second, region: "sgp" });
    assert.equal(harness.opened, 2);
    assert.equal(harness.closed, 2);
  });

  it("reports script load failures and still closes the page", async () => {
    const harness = createHarness();
    const page = await harness.deps.openPage({ id: "test" } as never);
    harness.deps.openPage = async () => ({
      ...page,
      async addScriptTag() {
        throw new Error("network unavailable");
      },
    });
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await assert.rejects(
      solver.solve(),
      (error: unknown) =>
        error instanceof Error && /script.*load/i.test(error.message) && /network unavailable/i.test(error.message)
    );
    assert.equal(harness.closed, 1);
  });

  it("times out a verification that never produces a token", async () => {
    const harness = createHarness();
    harness.deps.openPage = async () => ({
      async addScriptTag() {},
      async evaluate<T>(): Promise<T> {
        return undefined as T;
      },
      async waitForFunction<T>(): Promise<T> {
        return new Promise<T>(() => {});
      },
      async close() {
        // The solver must clean up even when the browser wait is still pending.
      },
    });
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await assert.rejects(solver.solve({ timeoutMs: 20 }), /timed out/i);
  });

  it("reports a verification callback failure", async () => {
    const harness = createHarness([VALID_TOKEN], "captcha business verification failed");
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await assert.rejects(solver.solve(), /captcha business verification failed/i);
  });

  it("rejects a verification parameter shorter than the minimum length", async () => {
    const harness = createHarness(["too-short"]);
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await assert.rejects(solver.solve(), /verification.*failed|invalid.*verifyParam/i);
  });
});
