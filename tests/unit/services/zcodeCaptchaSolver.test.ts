import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ZcodeCaptchaSolver,
  type ZcodeCaptchaPage,
  type ZcodeCaptchaSolverDependencies,
} from "../../../open-sse/services/zcodeCaptchaSolver.ts";

const VALID_TOKEN = "v".repeat(280);
const CAPTCHA_STATE_KEY = "__zcodeCaptchaState";

type CaptchaResponse = { captchaResult: boolean; bizResult: boolean };
type CaptchaVerifyCallback = (
  captchaVerifyParam: unknown,
  callback?: (response: CaptchaResponse) => void
) => CaptchaResponse | Promise<CaptchaResponse> | void;
type CapturedCaptchaOptions = {
  captchaVerifyCallback: CaptchaVerifyCallback;
};
type CaptchaState = { verifyParam: string | null; error: string | null };
type CaptchaWindow = Record<string, unknown> & {
  initAliyunCaptcha?: (options: CapturedCaptchaOptions) => void;
};
type CaptchaDocument = { body: { innerHTML: string } };

type Harness = {
  deps: ZcodeCaptchaSolverDependencies;
  acquired: Array<{ key: string; options: Record<string, unknown> }>;
  opened: number;
  closed: number;
  scripts: string[];
  captchaOptions: CapturedCaptchaOptions | null;
  captchaState: CaptchaState;
};

function createHarness(
  tokens: string[] = [VALID_TOKEN],
  verificationError: string | null = null
): Harness {
  const acquired: Harness["acquired"] = [];
  const scripts: string[] = [];
  let opened = 0;
  let closed = 0;
  let captchaOptions: CapturedCaptchaOptions | null = null;
  const captchaState: CaptchaState = { verifyParam: null, error: null };
  const fakeWindow: CaptchaWindow = {
    initAliyunCaptcha(options) {
      captchaOptions = options;
    },
  };
  const fakeDocument: CaptchaDocument = { body: { innerHTML: "" } };
  const evaluateContext = { window: fakeWindow, document: fakeDocument };

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
        async evaluate<T>(fn: unknown, arg?: unknown): Promise<T> {
          const serialized = String(fn);
          if (serialized.includes("CAPTCHA_STATE_KEY") || serialized.includes("asErrorMessage")) {
            throw new Error("page.evaluate callback captured a Node-only helper");
          }
          // The first evaluation installs the DOM/config and starts the captcha;
          // the final evaluation reads the state after waitForFunction resolves.
          if (serialized.includes("return value")) {
            const stateKey = arg as string;
            const state = fakeWindow[stateKey] as CaptchaState | undefined;
            if (state) {
              state.verifyParam = token;
              state.error = verificationError;
            } else {
              fakeWindow[stateKey] = captchaState;
              captchaState.verifyParam = token;
              captchaState.error = verificationError;
            }
          }
          const evaluateGlobal = globalThis as typeof globalThis & {
            window?: CaptchaWindow;
            document?: CaptchaDocument;
          };
          const hadWindow = Object.hasOwn(evaluateGlobal, "window");
          const hadDocument = Object.hasOwn(evaluateGlobal, "document");
          const previousWindow = evaluateGlobal.window;
          const previousDocument = evaluateGlobal.document;
          evaluateGlobal.window = fakeWindow;
          evaluateGlobal.document = fakeDocument;
          let result: T;
          try {
            result = (fn as (value?: unknown) => T).call(evaluateContext, arg);
          } finally {
            if (hadWindow) evaluateGlobal.window = previousWindow;
            else delete evaluateGlobal.window;
            if (hadDocument) evaluateGlobal.document = previousDocument;
            else delete evaluateGlobal.document;
          }
          if (serialized.includes("initAliyunCaptcha")) {
            return undefined as T;
          }
          if (serialized.includes("return value")) {
            const resultState = result as CaptchaState | null;
            if (resultState) {
              captchaState.verifyParam = resultState.verifyParam;
              captchaState.error = resultState.error;
            }
          }
          return result;
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
    get captchaOptions() {
      return captchaOptions;
    },
    get captchaState() {
      return (fakeWindow[CAPTCHA_STATE_KEY] as CaptchaState | undefined) ?? captchaState;
    },
  } as Harness;
}

describe("ZcodeCaptchaSolver", () => {
  it("exposes invalidate for clearing the current captcha token", async () => {
    const solver = new ZcodeCaptchaSolver();
    assert.equal(typeof solver.invalidate, "function");
    solver.invalidate();
  });
  it("acquires a headed context, returns a fresh verify param, and closes the page", async () => {
    const harness = createHarness();
    const solver = new ZcodeCaptchaSolver(harness.deps);

    const result = await solver.solve({ timeoutMs: 1_000 });

    assert.deepEqual(result, { verifyParam: VALID_TOKEN, region: "sgp" });
    assert.equal(harness.acquired.length, 1);
    assert.equal(harness.acquired[0]?.key, "zcode-captcha");
    assert.equal(harness.acquired[0]?.options.headless, false);
    assert.equal(
      harness.scripts[0],
      "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"
    );
    assert.equal(harness.closed, 1);
  });

  it("captures the Aliyun callback and accepts an object verification request", async () => {
    const harness = createHarness();
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await solver.solve();

    assert.ok(harness.captchaOptions);
    const callbackResult = harness.captchaOptions.captchaVerifyCallback({
      sceneId: "11xygtvd",
      certifyId: "test-cert",
      deviceToken: "a".repeat(200),
    });

    assert.deepEqual(callbackResult, { captchaResult: true, bizResult: true });
    assert.equal(
      harness.captchaState.verifyParam,
      JSON.stringify({
        sceneId: "11xygtvd",
        certifyId: "test-cert",
        deviceToken: "a".repeat(200),
      })
    );
  });

  it("accepts a serialized verification request and calls the SDK response callback", async () => {
    const harness = createHarness();
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await solver.solve();

    assert.ok(harness.captchaOptions);
    let callbackResponse: CaptchaResponse | undefined;
    const verifyParam = "test-verify-param-token".repeat(15);
    const callbackResult = harness.captchaOptions.captchaVerifyCallback(verifyParam, (response) => {
      callbackResponse = response;
    });

    assert.deepEqual(callbackResult, { captchaResult: true, bizResult: true });
    assert.deepEqual(callbackResponse, { captchaResult: true, bizResult: true });
    assert.equal(harness.captchaState.verifyParam, verifyParam);
  });

  it("records a failure for an empty verification request", async () => {
    const harness = createHarness();
    const solver = new ZcodeCaptchaSolver(harness.deps);

    await solver.solve();

    assert.ok(harness.captchaOptions);
    assert.deepEqual(harness.captchaOptions.captchaVerifyCallback(null), {
      captchaResult: true,
      bizResult: true,
    });
    assert.equal(harness.captchaState.error, "captcha verification returned an empty verifyParam");
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
        error instanceof Error &&
        /script.*load/i.test(error.message) &&
        /network unavailable/i.test(error.message)
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
