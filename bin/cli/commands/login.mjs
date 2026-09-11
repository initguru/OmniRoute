import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * `omniroute login antigravity` — local OAuth helper for remote installs.
 *
 * Why this exists: Google's `firstparty/nativeapp` consent for the embedded
 * Antigravity desktop client only releases the authorization code when the
 * loopback redirect (127.0.0.1:<port>) is REACHABLE. On a remote VPS install the
 * loopback is unreachable, so the consent hangs forever and never emits a code —
 * the dashboard's "paste the callback URL" fallback has nothing to paste. (The
 * same flow works locally and over an SSH tunnel, where the loopback IS reachable.)
 *
 * This command runs the OAuth on the user's OWN machine — where 127.0.0.1 works —
 * captures the code on a local loopback server, exchanges it for tokens, and
 * prints a single-line credential blob. The user pastes that blob into the remote
 * dashboard (Antigravity → "Paste credentials"), which decodes it, finalizes the
 * onboarding server-side, and persists the connection.
 *
 * It talks ONLY to Google (no OmniRoute server needed locally), so it works even
 * if the remote VPS is firewalled from the user's machine.
 *
 * Push mode: when an active remote context exists (`omniroute connect <host>`), the
 * blob is POSTed straight to that install instead of being printed for a manual
 * copy-paste — every piece was already in place:
 *
 *   - the context carries an admin-scoped token, and `apiFetch()` injects it;
 *   - `/api/oauth` requires admin scope (src/server/authz/accessScopes.ts) and stays
 *     remote-reachable — routeGuard.ts loopback-gates only `/api/oauth/cursor/auto-import`;
 *   - `/api/oauth/<provider>/paste-credentials` already decodes the blob and persists.
 *
 * The push NEVER becomes a hard requirement: this helper exists precisely because it
 * needs no route to the VPS, so a failed push falls back to printing the blob rather
 * than losing an authorization the operator just completed in their browser.
 */

const PROVIDER = "antigravity";

/** Open the system browser; no-op if the optional `open` dependency is missing. */
async function defaultOpenBrowser(url) {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
    // `open` not available — the caller already printed the URL to paste manually.
  }
}

/**
 * Start a loopback HTTP server bound to 127.0.0.1 (NOT 0.0.0.0 — we never want to
 * expose the callback to the LAN). Resolves to { port, waitForCallback, close }.
 */
function defaultStartServer(preferredPort) {
  return new Promise((resolve, reject) => {
    let resolveCallback;
    const callbackPromise = new Promise((r) => {
      resolveCallback = r;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>OmniRoute</title>" +
          '<body style="font-family:system-ui;padding:2rem">' +
          "<h2>✅ Authorization received</h2>" +
          "<p>Return to your terminal — you can close this tab.</p></body>"
      );
      resolveCallback(params);
    });

    server.on("error", reject);
    server.listen(preferredPort || 0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        waitForCallback: () => callbackPromise,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Is this context pointing at another machine? Loopback (and an unresolvable value)
 * counts as local, so we never auto-push somewhere we cannot reason about.
 */
export function isRemoteBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const { hostname } = new URL(baseUrl);
    const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

/**
 * POST a credential blob to the active context's install. Never throws: the caller
 * decides whether a failure is fatal (it is not — it falls back to printing).
 */
export async function pushCredentialBlob(provider, blob, deps = {}) {
  try {
    const fetchImpl = deps.fetchImpl ?? (await import("../api.mjs")).apiFetch;
    const res = await fetchImpl(`/api/oauth/${provider}/paste-credentials`, {
      method: "POST",
      body: { blob },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      const message =
        (typeof data?.error === "string" ? data.error : data?.error?.message) ||
        `HTTP ${res.status}`;
      return { ok: false, error: message };
    }
    return { ok: true, connectionId: data?.connection?.id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Read the active CLI context (baseUrl + scoped token) written by `omniroute connect`. */
async function defaultResolveContext(overrideName) {
  const { resolveActiveContext } = await import("../contexts.mjs");
  return resolveActiveContext(overrideName);
}

/** Lazy-load the antigravity provider + blob codec (TS source via tsx). */
async function loadDeps() {
  const { antigravity } = await import("../../../src/lib/oauth/providers/antigravity.ts");
  const { encodeCredentialBlob } = await import("../../../src/lib/oauth/credentialBlob.ts");
  return { antigravity, encodeCredentialBlob };
}

/**
 * Build the Google authorization request for a given loopback port. Uses a plain
 * authorization_code grant (NO PKCE code_challenge) — matching the working flow:
 * a code_challenge here would force the exchange to require a code_verifier.
 */
export async function buildAntigravityAuthRequest(port, makeState = randomUUID) {
  const { antigravity } = await loadDeps();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = makeState();
  const authUrl = antigravity.buildAuthUrl(antigravity.config, redirectUri, state);
  return { redirectUri, state, authUrl };
}

/** Exchange the captured code for raw Google tokens (no code_verifier — no PKCE). */
export async function exchangeAntigravityCode(code, redirectUri) {
  const { antigravity } = await loadDeps();
  return antigravity.exchangeToken(antigravity.config, code, redirectUri);
}

/**
 * Orchestrate the local login. Dependencies are injectable for testing; the real
 * path uses a 127.0.0.1 loopback server, the system browser, and a live token
 * exchange against Google. Returns the credential blob string.
 */
export async function runAntigravityLogin(opts = {}, deps = {}) {
  const startServer = deps.startServer ?? defaultStartServer;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const exchange = deps.exchange ?? exchangeAntigravityCode;
  const makeState = deps.makeState ?? randomUUID;
  const print = deps.print ?? ((s) => process.stdout.write(s));
  const log = deps.log ?? ((s) => process.stderr.write(s));
  const { encodeCredentialBlob } = await loadDeps();

  const server = await startServer(opts.port);
  const { redirectUri, state, authUrl } = await buildAntigravityAuthRequest(server.port, makeState);

  log(`\nOpen this URL to authorize Antigravity (it will open automatically):\n\n  ${authUrl}\n\n`);
  if (opts.browser !== false) await openBrowser(authUrl);
  log("Waiting for Google to redirect back to the local loopback...\n");

  const timeoutMs = opts.timeout ?? 300000;
  let timer;
  let params;
  try {
    params = await Promise.race([
      server.waitForCallback(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the OAuth callback")),
          timeoutMs
        );
        // Don't keep the event loop alive solely for this timer.
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await server.close();
  }

  if (params.error) {
    throw new Error(`Authorization failed: ${params.error_description || params.error}`);
  }
  if (params.state !== state) {
    throw new Error("State mismatch — aborting (possible CSRF). Please retry the login.");
  }
  if (!params.code) {
    throw new Error("No authorization code returned by Google.");
  }

  const tokens = await exchange(params.code, redirectUri);
  const blob = encodeCredentialBlob({ provider: PROVIDER, tokens });

  // Push when the operator explicitly asked, or when the active context already points
  // at another machine — that is exactly the situation this helper was built for.
  const resolveContext = deps.resolveContext ?? defaultResolveContext;
  const push = deps.push ?? pushCredentialBlob;
  let context = null;
  try {
    context = await resolveContext(opts.context);
  } catch {
    // No usable context store — fall through to printing.
  }
  const wantsPush =
    opts.push === true || (opts.push !== false && isRemoteBaseUrl(context?.baseUrl));

  if (wantsPush) {
    log(`\nSending the credential to ${context?.baseUrl || "the active context"}...\n`);
    const result = await push(PROVIDER, blob, { context });
    if (result?.ok) {
      log(
        `Antigravity connected on ${context?.baseUrl || "the remote install"}` +
          `${result.connectionId ? ` (connection ${result.connectionId})` : ""}.\n` +
          "Nothing to paste — you can close this terminal.\n"
      );
      // Deliberately NOT printed: the blob wraps a refresh token and it already landed.
      return blob;
    }
    log(
      `\nCould not deliver the credential automatically: ${result?.error || "unknown error"}\n` +
        "Falling back to manual paste — the authorization itself is still valid.\n"
    );
  }

  print(
    "\n" +
      "Antigravity authorized. Copy the line below and paste it into your remote\n" +
      'OmniRoute dashboard: Providers → Antigravity → Connect → "Paste credentials".\n' +
      "(This contains a refresh token — treat it like a password.)\n\n" +
      blob +
      "\n\n"
  );
  return blob;
}

const GEMINI_LOGIN_URL = "https://gemini.google.com/app";
const GEMINI_COOKIE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"];

/**
 * Format an array or dictionary of cookies into the Gemini Web apiKey string.
 */
export function formatGeminiWebCookieString(cookies) {
  const map = new Map();
  if (Array.isArray(cookies)) {
    for (const c of cookies) {
      if (c && c.name && c.value) {
        map.set(c.name, String(c.value).trim());
      }
    }
  } else if (cookies && typeof cookies === "object") {
    for (const [key, val] of Object.entries(cookies)) {
      if (typeof val === "string" && val.trim()) {
        map.set(key, val.trim());
      }
    }
  }

  const parts = [];
  for (const name of GEMINI_COOKIE_NAMES) {
    const val = map.get(name);
    if (val) {
      parts.push(`${name}=${val}`);
    }
  }
  return parts.join("; ");
}

/**
 * Extract __Secure-1PSID, __Secure-1PSIDTS, __Secure-1PSIDCC from cookies.
 */
export function extractGeminiWebCookies(cookies) {
  if (!cookies) return null;

  if (!Array.isArray(cookies)) {
    if (typeof cookies === "object") {
      const psid = cookies["__Secure-1PSID"] || null;
      if (!psid) return null;
      return {
        psid,
        psidts: cookies["__Secure-1PSIDTS"] || null,
        psidcc: cookies["__Secure-1PSIDCC"] || null,
        formatted: formatGeminiWebCookieString(cookies),
      };
    }
    return null;
  }

  const findCookie = (name) =>
    cookies.find(
      (c) =>
        c.name === name &&
        (!c.domain || c.domain === "google.com" || c.domain.endsWith(".google.com"))
    );

  const psidCookie = findCookie("__Secure-1PSID");
  if (!psidCookie?.value) return null;

  const psid = psidCookie.value.trim();
  const psidts = findCookie("__Secure-1PSIDTS")?.value?.trim() || null;
  const psidcc = findCookie("__Secure-1PSIDCC")?.value?.trim() || null;

  const formatted = formatGeminiWebCookieString([
    { name: "__Secure-1PSID", value: psid },
    ...(psidts ? [{ name: "__Secure-1PSIDTS", value: psidts }] : []),
    ...(psidcc ? [{ name: "__Secure-1PSIDCC", value: psidcc }] : []),
  ]);

  return {
    psid,
    psidts,
    psidcc,
    formatted,
  };
}

/**
 * Persist Gemini Web apiKey to the local OmniRoute store (API if server is up, else SQLite).
 */
export async function saveGeminiWebCredential(apiKey, deps = {}) {
  const provider = "gemini-web";

  // 1. Try API if server is running
  const isServerUpImpl = deps.isServerUp ?? (await import("../api.mjs")).isServerUp;
  const apiFetchImpl = deps.apiFetch ?? (await import("../api.mjs")).apiFetch;

  try {
    if (await isServerUpImpl()) {
      const res = await apiFetchImpl("/api/v1/providers/keys", {
        method: "POST",
        body: { provider, apiKey },
        retry: false,
        acceptNotOk: true,
      });
      if (res && res.ok) {
        return { success: true, via: "api" };
      }
    }
  } catch {
    // fall through to local SQLite
  }

  // 2. Direct SQLite storage
  try {
    const openDb = deps.openOmniRouteDb ?? (await import("../sqlite.mjs")).openOmniRouteDb;
    const listConnections =
      deps.listProviderConnections ??
      (await import("../provider-store.mjs")).listProviderConnections;
    const upsertConnection =
      deps.upsertApiKeyProviderConnection ??
      (await import("../provider-store.mjs")).upsertApiKeyProviderConnection;

    const { db } = await openDb();
    try {
      const existing = listConnections(db).find(
        (c) => c.provider === provider && c.authType === "apikey"
      );
      upsertConnection(db, {
        provider,
        name: existing?.name || provider,
        apiKey,
      });
      return { success: true, via: "db" };
    } finally {
      if (db && typeof db.close === "function") {
        db.close();
      }
    }
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Parse cookies and save to provider store.
 */
export async function parseAndSaveGeminiWebCookies(cookies, deps = {}) {
  let formatted = "";
  if (typeof cookies === "string" && cookies.includes("=")) {
    formatted = cookies;
  } else {
    const extracted = extractGeminiWebCookies(cookies);
    if (!extracted) {
      return { success: false, error: "Missing required __Secure-1PSID cookie" };
    }
    formatted = extracted.formatted;
  }

  const saveFn = deps.saveCredential ?? saveGeminiWebCredential;
  const saveResult = await saveFn(formatted, deps);
  return {
    success: saveResult?.success ?? false,
    apiKey: formatted,
    ...saveResult,
  };
}

async function defaultLaunchGeminiBrowser(options = {}) {
  const { default: playwright } = await import("playwright");
  const headless = options.headless ?? false;
  const configuredPath = process.env.OMNIROUTE_LOGIN_BROWSER_PATH?.trim();
  const attempts = [
    ...(configuredPath ? [{ headless, executablePath: configuredPath }] : []),
    { headless, channel: "chrome" },
    { headless, channel: "msedge" },
    { headless },
  ];

  let lastError;
  for (const launchOpts of attempts) {
    try {
      return await playwright.chromium.launch(launchOpts);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No compatible Chromium browser is available for sign-in");
}

/**
 * Launch interactive browser, wait for login at gemini.google.com/app,
 * extract __Secure-1PSID* cookies, format and persist to local store.
 */
export async function runGeminiWebLogin(opts = {}, deps = {}) {
  const log = deps.log ?? ((s) => process.stderr.write(s));
  const print = deps.print ?? ((s) => process.stdout.write(s));
  const timeout = opts.timeout ?? 300000;
  const headless = Boolean(opts.headless);
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;

  log("\nGoogle 계정 로그인을 완료해 주세요...\n");
  log(`브라우저가 열립니다: ${GEMINI_LOGIN_URL}\n`);

  let browser = deps.browser;
  if (!browser) {
    const launchBrowser = deps.launchBrowser ?? defaultLaunchGeminiBrowser;
    browser = await launchBrowser({ headless });
  }

  try {
    const context =
      deps.context ??
      (browser.newContext
        ? await browser.newContext({
            viewport: { width: 1280, height: 800 },
            locale: "en-US",
          })
        : null);

    const page = deps.page ?? (context?.newPage ? await context.newPage() : null);

    if (page?.goto) {
      await page
        .goto(GEMINI_LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(timeout, 60000),
        })
        .catch(() => {});
    }

    const deadline = Date.now() + timeout;
    let extracted = null;

    while (Date.now() < deadline) {
      let cookies = [];
      if (context?.cookies) {
        cookies = await context
          .cookies([".google.com", "https://gemini.google.com", "https://google.com"])
          .catch(() => []);
      }

      const candidate = extractGeminiWebCookies(cookies);
      if (candidate) {
        let ready = false;
        try {
          const currentUrl = page?.url ? page.url() : "";
          if (currentUrl && currentUrl.includes("gemini.google.com/app")) {
            ready = true;
          }
          if (!ready && page?.locator) {
            const editorCount = await page
              .locator(".ql-editor")
              .count()
              .catch(() => 0);
            if (editorCount > 0) ready = true;
          }
        } catch {
          // page may still be navigating
        }

        if (ready) {
          extracted = candidate;
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (!extracted) {
      throw new Error("Timed out waiting for Gemini Web login or missing __Secure-1PSID cookie");
    }

    const formattedApiKey = extracted.formatted;
    const saveFn = deps.saveCredential ?? saveGeminiWebCredential;
    const saveResult = await saveFn(formattedApiKey, deps);

    if (saveResult?.success) {
      log("\n[Gemini Web] 로그인 완료 및 세션 쿠키가 저장되었습니다.\n");
    } else {
      print(
        "\n[Gemini Web] 세션 쿠키 추출 완료:\n\n" +
          formattedApiKey +
          "\n\n(로컬 저장소에 저장하지 못했습니다. 위 쿠키를 대시보드 또는 CLI로 등록하세요.)\n"
      );
    }

    return {
      success: true,
      apiKey: formattedApiKey,
      extracted,
      saveResult,
    };
  } finally {
    if (browser && typeof browser.close === "function") {
      try {
        await browser.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

async function runLoginGeminiWeb(opts) {
  try {
    await runGeminiWebLogin({
      headless: opts.headless,
      timeout: opts.timeout,
    });
  } catch (err) {
    process.stderr.write(`\nGemini Web login failed: ${err?.message || err}\n`);
    process.exit(1);
  }
}

async function runLoginAntigravity(opts) {
  try {
    await runAntigravityLogin({
      browser: opts.browser,
      timeout: opts.timeout,
      port: opts.port,
      push: opts.push,
      context: opts.context,
    });
  } catch (err) {
    process.stderr.write(`\nLogin failed: ${err?.message || err}\n`);
    process.exit(1);
  }
}

export function registerLogin(program) {
  const login = program
    .command("login")
    .description("Local OAuth and web-session helpers for OmniRoute");

  login
    .command("antigravity")
    .description("Authorize Antigravity locally and print a credential blob to paste remotely")
    .option("--no-browser", "Do not auto-open the browser; print the URL instead")
    .option("--port <n>", "Fixed loopback port (default: OS-assigned)", (v) => parseInt(v, 10))
    .option("--timeout <ms>", "How long to wait for the callback", (v) => parseInt(v, 10), 300000)
    .option(
      "--push",
      "Send the credential to the active context instead of printing it (default when that context is remote)"
    )
    .option("--no-push", "Always print the blob, never contact the server")
    .option("--context <name>", "Push to this context instead of the active one")
    .action(runLoginAntigravity);

  login
    .command("gemini-web")
    .alias("gemini")
    .description("Log in to Gemini Web via browser and save session cookies")
    .option("--headless", "Run browser in headless mode")
    .option("--timeout <ms>", "How long to wait for login (ms)", (v) => parseInt(v, 10), 300000)
    .action(runLoginGeminiWeb);
}
