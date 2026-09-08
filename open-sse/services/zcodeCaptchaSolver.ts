import {
  acquireBrowserContext,
  openPage,
  type BrowserPoolContextOptions,
  type PooledContext,
} from "./browserPool.ts";
import type { Page } from "playwright";

const ALIYUN_CAPTCHA_SCRIPT_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const ALIYUN_CAPTCHA_REGION = "sgp";
const ALIYUN_CAPTCHA_PREFIX = "no8xfe";
const ALIYUN_CAPTCHA_SCENE_ID = "11xygtvd";
const CAPTCHA_POOL_KEY = "zcode-captcha";
const CAPTCHA_COOKIE_DOMAIN = ".alicdn.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_VERIFY_PARAM_LENGTH = 200;
const CAPTCHA_STATE_KEY = "__zcodeCaptchaState";

interface CaptchaState {
  verifyParam: string | null;
  error: string | null;
}

type AliyunCaptchaInstance = {
  startTracelessVerification?: () => void;
};

type AliyunCaptchaResponse = { captchaResult: boolean; bizResult: boolean };

interface AliyunCaptchaOptions {
  SceneId: string;
  prefix: string;
  mode: "popup";
  element: string;
  button: string;
  captchaVerifyCallback: (
    captchaVerifyParam: unknown,
    callback?: (res: AliyunCaptchaResponse) => void
  ) => AliyunCaptchaResponse | Promise<AliyunCaptchaResponse> | void;
  onBizResultCallback: (bizResult: unknown) => void;
  getInstance: (instance: AliyunCaptchaInstance) => void;
  slideStyle: { width: number; height: number };
  language: "cn";
  immediate: false;
}

type AliyunCaptchaWindow = Window & {
  AliyunCaptchaConfig?: { region: string; prefix: string };
  initAliyunCaptcha?: (options: AliyunCaptchaOptions) => void;
  [CAPTCHA_STATE_KEY]?: CaptchaState;
};

export type ZcodeCaptchaPage = Page;

export interface ZcodeCaptchaSolverDependencies {
  acquireBrowserContext(key: string, options: BrowserPoolContextOptions): Promise<PooledContext>;
  openPage(pooled: PooledContext): Promise<ZcodeCaptchaPage>;
}

const defaultDependencies: ZcodeCaptchaSolverDependencies = {
  acquireBrowserContext,
  openPage,
};

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Zcode captcha timeoutMs must be a positive finite number");
  }
  return Math.floor(timeoutMs);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timed? ?out|timeout/i.test(error.message);
}

function timeoutAfter<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Zcode captcha timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

async function installCaptcha(page: ZcodeCaptchaPage): Promise<void> {
  try {
    await page.addInitScript("window.__name = function(fn) { return fn; };");
    await page.evaluate("window.__name = function(fn) { return fn; };");
  } catch {
    // Ignore init script fallback errors if unsupported by mock
  }

  await page.evaluate((stateKey) => {
    const pageWindow = window as AliyunCaptchaWindow;
    document.body.innerHTML =
      '<div id="captcha-element"></div><button id="captcha-btn" type="button"></button>';
    pageWindow.AliyunCaptchaConfig = {
      region: "sgp",
      prefix: "no8xfe",
    };
    pageWindow[stateKey] = {
      verifyParam: null,
      error: null,
    };
  }, CAPTCHA_STATE_KEY);

  try {
    await page.addScriptTag({ url: ALIYUN_CAPTCHA_SCRIPT_URL });
  } catch (error) {
    throw new Error(`Zcode captcha script load failed: ${asErrorMessage(error)}`);
  }

  try {
    await page.evaluate(
      ({ sceneId, prefix, stateKey }) => {
        const pageWindow = window as AliyunCaptchaWindow;
        const state = pageWindow[stateKey];
        const initAliyunCaptcha = pageWindow.initAliyunCaptcha;
        if (!state) {
          throw new Error("captcha state was not initialized");
        }
        if (typeof initAliyunCaptcha !== "function") {
          throw new Error("initAliyunCaptcha is unavailable after script load");
        }

        const setFailure = (message: string): void => {
          state.error = message;
        };

        initAliyunCaptcha({
          SceneId: sceneId,
          prefix,
          mode: "popup",
          element: "#captcha-element",
          button: "#captcha-btn",
          captchaVerifyCallback: (
            captchaVerifyParam: unknown,
            callback?: (res: AliyunCaptchaResponse) => void
          ) => {
            const response: AliyunCaptchaResponse = { captchaResult: true, bizResult: true };
            let serializedVerifyParam: string | null = null;
            if (typeof captchaVerifyParam === "string") {
              if (captchaVerifyParam.length > 0) {
                serializedVerifyParam = captchaVerifyParam;
              }
            } else if (typeof captchaVerifyParam === "object" && captchaVerifyParam !== null) {
              serializedVerifyParam = JSON.stringify(captchaVerifyParam);
            }
            if (!serializedVerifyParam) {
              setFailure("captcha verification returned an empty verifyParam");
            } else {
              state.verifyParam = serializedVerifyParam;
            }
            if (typeof callback === "function") {
              callback(response);
            }
            return response;
          },
          onBizResultCallback: (bizResult: unknown) => {
            if (bizResult === false) {
              setFailure("captcha business verification failed");
              return;
            }
            if (!bizResult || typeof bizResult !== "object") return;
            const result = bizResult as Record<string, unknown>;
            if (result.success === false || result.passed === false || result.result === false) {
              setFailure("captcha business verification failed");
            }
          },
          getInstance: (instance: AliyunCaptchaInstance) => {
            if (typeof instance?.startTracelessVerification !== "function") {
              setFailure("captcha instance does not support traceless verification");
              return;
            }
            try {
              instance.startTracelessVerification();
            } catch (error) {
              setFailure(
                `traceless verification failed: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          },
          slideStyle: { width: 360, height: 40 },
          language: "cn",
          immediate: false,
        });
      },
      {
        sceneId: ALIYUN_CAPTCHA_SCENE_ID,
        prefix: ALIYUN_CAPTCHA_PREFIX,
        stateKey: CAPTCHA_STATE_KEY,
      }
    );
  } catch (error) {
    throw new Error(`Zcode captcha verification failed: ${asErrorMessage(error)}`);
  }
}

async function waitForCaptchaResult(
  page: ZcodeCaptchaPage,
  timeoutMs: number
): Promise<CaptchaState> {
  try {
    await page.waitForFunction(
      (stateKey) => {
        const state = (window as AliyunCaptchaWindow)[stateKey];
        return Boolean(state?.verifyParam || state?.error);
      },
      CAPTCHA_STATE_KEY,
      { polling: 50, timeout: timeoutMs }
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`Zcode captcha timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Zcode captcha verification failed: ${asErrorMessage(error)}`);
  }

  const state = await page.evaluate((stateKey) => {
    const value = (window as AliyunCaptchaWindow)[stateKey];
    return value ? { verifyParam: value.verifyParam, error: value.error } : null;
  }, CAPTCHA_STATE_KEY);
  if (!state) {
    throw new Error("Zcode captcha verification failed: captcha state disappeared");
  }
  return state;
}

/**
 * Single-use, on-demand Alibaba captcha solver. A certifyId/verifyParam is
 * bound to one upstream turn and must never be reused; each solve opens a new
 * page. `invalidate()` clears the diagnostic token reference after a rejected
 * verification so no stale state survives into the next turn.
 */
export class ZcodeCaptchaSolver {
  private currentToken: { verifyParam: string; region: string } | null = null;

  constructor(
    private readonly dependencies: ZcodeCaptchaSolverDependencies = defaultDependencies
  ) {}

  /** Solve one turn's captcha; returned verification is not reusable across turns. */
  async solve(options?: { timeoutMs?: number }): Promise<{ verifyParam: string; region: string }> {
    const timeoutMs = resolveTimeout(options?.timeoutMs);
    const pooled = await this.dependencies.acquireBrowserContext(CAPTCHA_POOL_KEY, {
      cookieDomain: CAPTCHA_COOKIE_DOMAIN,
      headless: false,
    });
    const page = await this.dependencies.openPage(pooled);

    try {
      const result = await timeoutAfter(
        (async () => {
          await installCaptcha(page);
          const state = await waitForCaptchaResult(page, timeoutMs);
          if (state.error) {
            throw new Error(`Zcode captcha verification failed: ${state.error}`);
          }
          if (!state.verifyParam || state.verifyParam.length < MIN_VERIFY_PARAM_LENGTH) {
            throw new Error("Zcode captcha verification failed: invalid verifyParam");
          }
          return { verifyParam: state.verifyParam, region: ALIYUN_CAPTCHA_REGION };
        })(),
        timeoutMs
      );
      this.currentToken = result;
      return result;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Clear any cached captcha result so the next solve obtains fresh verification. */
  invalidate(): void {
    this.currentToken = null;
  }
}
