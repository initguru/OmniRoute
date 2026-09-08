import assert from "node:assert/strict";
import test from "node:test";

import {
  ZcodeCaptchaSolver,
  type ZcodeCaptchaPage,
  type ZcodeCaptchaSolverDependencies,
} from "../../open-sse/services/zcodeCaptchaSolver.ts";

type CaptchaResponse = { captchaResult: boolean; bizResult: boolean };
type CaptchaOptions = {
  SceneId: string;
  prefix: string;
  captchaVerifyCallback: (
    captchaVerifyParam: unknown,
    callback?: (response: CaptchaResponse) => void
  ) => CaptchaResponse | Promise<CaptchaResponse> | void;
  getInstance: (instance: { startTracelessVerification?: () => void }) => void;
};
type CaptchaState = { verifyParam: string | null; error: string | null };
type CaptchaWindow = Record<string, unknown> & {
  initAliyunCaptcha?: (options: CaptchaOptions) => void;
};
type CaptchaDocument = { body: { innerHTML: string } };
type PageGlobals = typeof globalThis & {
  window?: CaptchaWindow;
  document?: CaptchaDocument;
};

type SolverHarness = {
  dependencies: ZcodeCaptchaSolverDependencies;
  acquired: Array<{ key: string; options: Record<string, unknown> }>;
  scriptUrls: string[];
  state: CaptchaState;
  capturedOptions: CaptchaOptions | null;
  closed: number;
};

const VALID_VERIFY_PARAM = "verify-param-".repeat(30);
const CAPTCHA_STATE_KEY = "__zcodeCaptchaState";

function createHarness(options: { token?: string; scriptError?: Error } = {}): SolverHarness {
  const acquired: SolverHarness["acquired"] = [];
  const scriptUrls: string[] = [];
  const state: CaptchaState = { verifyParam: null, error: null };
  const fakeWindow: CaptchaWindow = {};
  const fakeDocument: CaptchaDocument = { body: { innerHTML: "" } };
  let capturedOptions: CaptchaOptions | null = null;
  let closed = 0;
  const token = options.token ?? VALID_VERIFY_PARAM;

  fakeWindow.initAliyunCaptcha = (captchaOptions) => {
    capturedOptions = captchaOptions;
    captchaOptions.getInstance({
      startTracelessVerification: () => {
        captchaOptions.captchaVerifyCallback(token);
      },
    });
  };

  const evaluateWithPageGlobals = async <T>(fn: unknown, arg?: unknown): Promise<T> => {
    const pageGlobals = globalThis as PageGlobals;
    const hadWindow = Object.hasOwn(pageGlobals, "window");
    const hadDocument = Object.hasOwn(pageGlobals, "document");
    const previousWindow = pageGlobals.window;
    const previousDocument = pageGlobals.document;
    pageGlobals.window = fakeWindow;
    pageGlobals.document = fakeDocument;
    try {
      return (fn as (value?: unknown) => T)(arg);
    } finally {
      if (hadWindow) pageGlobals.window = previousWindow;
      else delete pageGlobals.window;
      if (hadDocument) pageGlobals.document = previousDocument;
      else delete pageGlobals.document;
    }
  };

  const page = {
    async addScriptTag(script: { url: string }): Promise<void> {
      if (options.scriptError) throw options.scriptError;
      scriptUrls.push(script.url);
    },
    async evaluate<T>(fn: unknown, arg?: unknown): Promise<T> {
      const result = await evaluateWithPageGlobals<T>(fn, arg);
      const serialized = String(fn);
      if (serialized.includes("return value")) {
        const resultState = result as CaptchaState | null;
        if (resultState) {
          state.verifyParam = resultState.verifyParam;
          state.error = resultState.error;
        }
      }
      return result;
    },
    async waitForFunction<T>(): Promise<T> {
      return {} as T;
    },
    async close(): Promise<void> {
      closed += 1;
    },
  } as unknown as ZcodeCaptchaPage;

  const dependencies: ZcodeCaptchaSolverDependencies = {
    acquireBrowserContext: async (key, contextOptions) => {
      acquired.push({ key, options: contextOptions as unknown as Record<string, unknown> });
      return { id: key } as never;
    },
    openPage: async () => page,
  };

  return {
    dependencies,
    acquired,
    scriptUrls,
    get state() {
      return (fakeWindow[CAPTCHA_STATE_KEY] as CaptchaState | undefined) ?? state;
    },
    get capturedOptions() {
      return capturedOptions;
    },
    get closed() {
      return closed;
    },
  };
}

test("ZcodeCaptchaSolver exposes solve and obtains a token through injected browser-pool dependencies", async () => {
  const defaultSolver = new ZcodeCaptchaSolver();
  assert.equal(typeof defaultSolver.solve, "function");

  const harness = createHarness();
  const solver = new ZcodeCaptchaSolver(harness.dependencies);
  const result = await solver.solve({ timeoutMs: 500 });

  assert.deepEqual(result, { verifyParam: VALID_VERIFY_PARAM, region: "sgp" });
  assert.deepEqual(harness.acquired, [
    {
      key: "zcode-captcha",
      options: {
        cookieDomain: ".alicdn.com",
        headless: false,
      },
    },
  ]);
  assert.equal(harness.scriptUrls.length, 1);
  assert.equal(harness.capturedOptions?.SceneId, "11xygtvd");
  assert.equal(harness.capturedOptions?.prefix, "no8xfe");
  assert.equal(harness.closed, 1);
});

test("ZcodeCaptchaSolver preserves callback responses while serializing object verification parameters", async () => {
  const harness = createHarness();
  const solver = new ZcodeCaptchaSolver(harness.dependencies);
  await solver.solve();

  assert.ok(harness.capturedOptions);
  let callbackResponse: CaptchaResponse | undefined;
  const verificationRequest = { sceneId: "11xygtvd", certifyId: "certify-id" };
  const result = harness.capturedOptions.captchaVerifyCallback(verificationRequest, (response) => {
    callbackResponse = response;
  });

  assert.deepEqual(result, { captchaResult: true, bizResult: true });
  assert.deepEqual(callbackResponse, { captchaResult: true, bizResult: true });
  assert.equal(harness.state.verifyParam, JSON.stringify(verificationRequest));
});

test("ZcodeCaptchaSolver closes its page and reports browser script failures", async () => {
  const harness = createHarness({ scriptError: new Error("browser unavailable") });
  const solver = new ZcodeCaptchaSolver(harness.dependencies);

  await assert.rejects(solver.solve(), /captcha script load failed: browser unavailable/);
  assert.equal(harness.closed, 1);
});

test("ZcodeCaptchaSolver rejects invalid timeout values before acquiring a browser context", async () => {
  const harness = createHarness();
  const solver = new ZcodeCaptchaSolver(harness.dependencies);

  await assert.rejects(
    solver.solve({ timeoutMs: 0 }),
    /timeoutMs must be a positive finite number/
  );
  assert.equal(harness.acquired.length, 0);
});
