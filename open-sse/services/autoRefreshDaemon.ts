/**
 * AutoRefreshDaemon — Background cookie validity checker for web-cookie providers
 *
 * Periodically checks stored credentials for web-cookie providers by making
 * lightweight requests to their home pages. If a credential is expired, it
 * logs a warning and marks the credential for re-authentication.
 *
 * The daemon does NOT automatically re-login (that requires user interaction
 * for security). It alerts the system so higher-level components can decide
 * what to do (e.g., fallback to another provider, prompt user to re-login).
 */

import {
  mergeRotatedGeminiCookies,
  parseCookies,
  ParsedCookie,
} from "../executors/gemini-web/cookieUtils";
import { TOKEN_EXTRACTION_CONFIGS } from "./tokenExtractionConfig";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  checkedProviderCount: number;
  expiredCredentials: string[];
  lastRun: number | null;
}

interface StoredCredentialEntry {
  providerId: string;
  value: string;
  storedAt: number;
  onRefreshed?: (newValue: string) => Promise<void> | void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute minimum

// ─── Daemon ─────────────────────────────────────────────────────────────────

export class AutoRefreshDaemon {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private checkIntervalMs: number;
  private expiredCredentials: string[] = [];
  private lastRun: number | null = null;
  /** In-memory store of web-cookie credentials (real persistence uses SQLite) */
  private credentialStore = new Map<string, StoredCredentialEntry>();

  constructor(checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS) {
    this.checkIntervalMs = Math.max(checkIntervalMs, MIN_CHECK_INTERVAL_MS);
  }

  /**
   * Register a credential for auto-refresh monitoring.
   * Called when credentials are extracted/updated.
   */
  registerCredential(
    providerId: string,
    value: string,
    onRefreshed?: (newValue: string) => Promise<void> | void
  ): void {
    this.credentialStore.set(providerId, {
      providerId,
      value,
      storedAt: Date.now(),
      onRefreshed,
    });
  }

  /**
   * Update an existing credential value while preserving registered callbacks.
   */
  updateCredential(providerId: string, value: string): void {
    const existing = this.credentialStore.get(providerId);
    if (existing) {
      existing.value = value;
      existing.storedAt = Date.now();
    } else {
      this.registerCredential(providerId, value);
    }
  }

  /**
   * Get the current in-memory credential value for a provider.
   */
  getCredential(providerId: string): string | undefined {
    return this.credentialStore.get(providerId)?.value;
  }

  /**
   * Remove a credential from monitoring (e.g., provider deleted)
   */
  unregisterCredential(providerId: string): void {
    this.credentialStore.delete(providerId);
  }

  /**
   * Start the daemon — begins periodic credential checks
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Run an initial check immediately
    this.check().catch(() => {});

    this.timerId = setInterval(() => {
      this.check().catch(() => {});
    }, this.checkIntervalMs);
    // Don't keep the process alive solely for this periodic daemon.
    (this.timerId as { unref?: () => void })?.unref?.();

    console.log(
      `[AutoRefreshDaemon] Started — checking ${this.credentialStore.size} credentials every ${this.checkIntervalMs / 1000}s`
    );
  }

  /**
   * Stop the daemon
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    console.log("[AutoRefreshDaemon] Stopped");
  }

  /**
   * Check all stored credentials for validity.
   * Makes a lightweight HEAD/GET request to the provider's home page.
   */
  async check(): Promise<void> {
    this.lastRun = Date.now();
    const newlyExpired: string[] = [];

    const entries = [...this.credentialStore.entries()];

    for (const [providerId] of entries) {
      const config = TOKEN_EXTRACTION_CONFIGS.get(providerId);
      if (!config) {
        this.credentialStore.delete(providerId);
        continue;
      }

      try {
        const targetUrl =
          providerId === "gemini-web"
            ? config.loginUrl || "https://gemini.google.com/app"
            : config.homeUrl;
        const isValid = await this.validateCredential(providerId, targetUrl);
        if (!isValid) {
          newlyExpired.push(providerId);
          console.warn(
            `[AutoRefreshDaemon] Credential expired for "${providerId}" (${config.displayName})`
          );
        } else {
          const expiredIdx = this.expiredCredentials.indexOf(providerId);
          if (expiredIdx !== -1) {
            this.expiredCredentials.splice(expiredIdx, 1);
          }
        }
      } catch (err) {
        // Network errors are non-fatal — retry next cycle. G8: log which
        // provider failed so credential problems are not silently masked.
        console.warn(
          `[AutoRefreshDaemon] Network error validating credential for "${providerId}" — retry next cycle`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Update expired list
    for (const id of newlyExpired) {
      if (!this.expiredCredentials.includes(id)) {
        this.expiredCredentials.push(id);
      }
    }
  }

  /**
   * Validate a credential by making a request to the provider's home page.
   * Returns true if the response suggests the credential is still valid.
   */
  async validateCredential(providerId: string, homeUrl?: string): Promise<boolean> {
    const entry = this.credentialStore.get(providerId);
    if (!entry) return false;

    const config = TOKEN_EXTRACTION_CONFIGS.get(providerId);
    let targetUrl = homeUrl || config?.homeUrl || "";
    if (providerId === "gemini-web") {
      if (
        !targetUrl ||
        targetUrl === config?.homeUrl ||
        targetUrl === "https://gemini.google.com"
      ) {
        targetUrl = config?.loginUrl || "https://gemini.google.com/app";
      }
    }

    const isGemini = providerId === "gemini-web";
    const method = isGemini ? "GET" : "HEAD";
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    };
    if (entry.value) {
      headers["Cookie"] = entry.value;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(targetUrl, {
        method,
        signal: controller.signal,
        headers,
        redirect: "follow",
      });

      // 401/403 strongly suggest expired credential
      if (response.status === 401 || response.status === 403) {
        try {
          await response.body?.cancel();
        } catch {}
        return false;
      }

      if (isGemini) {
        const finalUrl = response.url || "";
        const location = response.headers.get("location") || "";
        const isGoogleLogin =
          finalUrl.includes("accounts.google.com/ServiceLogin") ||
          finalUrl.includes("accounts.google.com/v3/signin") ||
          finalUrl.includes("accounts.google.com") ||
          location.includes("accounts.google.com/ServiceLogin") ||
          location.includes("accounts.google.com/v3/signin") ||
          location.includes("accounts.google.com");

        if (isGoogleLogin) {
          try {
            await response.body?.cancel();
          } catch {}
          return false;
        }

        // Check for rotated cookies in Set-Cookie headers
        let rawSetCookies: string[] = [];
        if (typeof response.headers.getSetCookie === "function") {
          rawSetCookies = response.headers.getSetCookie();
        }
        const headersWithRaw = response.headers as unknown as {
          raw?: () => Record<string, string[]>;
        };
        if (rawSetCookies.length === 0 && typeof headersWithRaw.raw === "function") {
          const rawHeaders = headersWithRaw.raw();
          if (Array.isArray(rawHeaders["set-cookie"])) {
            rawSetCookies = rawHeaders["set-cookie"];
          }
        }
        if (rawSetCookies.length === 0) {
          const sc = response.headers.get("set-cookie");
          if (sc) {
            rawSetCookies = [sc];
          }
        }

        if (rawSetCookies.length > 0) {
          const jarCookies: ParsedCookie[] = [];
          for (const sc of rawSetCookies) {
            jarCookies.push(...parseCookies(sc));
          }

          if (jarCookies.length > 0) {
            const updatedCookie = mergeRotatedGeminiCookies(entry.value, jarCookies);
            if (updatedCookie !== entry.value) {
              entry.value = updatedCookie;
              entry.storedAt = Date.now();
              if (entry.onRefreshed) {
                try {
                  await entry.onRefreshed(updatedCookie);
                } catch (callbackErr) {
                  console.warn(
                    `[AutoRefreshDaemon] onRefreshed callback failed for "${providerId}":`,
                    callbackErr instanceof Error ? callbackErr.message : callbackErr
                  );
                }
              }
            }
          }
        }
      }

      try {
        await response.body?.cancel();
      } catch {}

      return true;
    } catch (err) {
      // Network errors (timeout, DNS failure) don't mean the credential is bad.
      // G8 (silent-stop fix): the previous bare `catch { return true; }` swallowed
      // the error entirely — operators could never tell a credential was failing
      // to validate due to network trouble. Log it (provider + reason) before
      // returning the fail-open result.
      console.warn(
        `[AutoRefreshDaemon] Network error validating credential for "${providerId}" — treated as valid (fail-open), will retry next cycle`,
        err instanceof Error ? err.message : err
      );
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get the current daemon status
   */
  getStatus(): DaemonStatus {
    return {
      running: this.running,
      checkedProviderCount: this.credentialStore.size,
      expiredCredentials: [...this.expiredCredentials],
      lastRun: this.lastRun,
    };
  }

  /**
   * Clear expired credentials list (e.g., after re-authentication)
   */
  clearExpired(): void {
    this.expiredCredentials = [];
  }

  /**
   * Restart the daemon (useful when config changes)
   */
  restart(): void {
    this.stop();
    this.start();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const autoRefreshDaemon = new AutoRefreshDaemon();

export function registerCredential(
  providerId: string,
  value: string,
  onRefreshed?: (newValue: string) => Promise<void> | void
): void {
  autoRefreshDaemon.registerCredential(providerId, value, onRefreshed);
}

export function updateCredential(providerId: string, value: string): void {
  autoRefreshDaemon.updateCredential(providerId, value);
}

export function getCredential(providerId: string): string | undefined {
  return autoRefreshDaemon.getCredential(providerId);
}
