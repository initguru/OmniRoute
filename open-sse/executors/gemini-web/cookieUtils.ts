/**
 * Shared cookie parsing and rotation utilities for Gemini Web executors.
 */

export interface ParsedCookie {
  name: string;
  value: string;
}

export const GEMINI_ROTATABLE_COOKIE_NAMES = [
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
] as const;

/**
 * Parse a raw cookie string (e.g., from a request or a Set-Cookie header)
 * into an array of { name, value } pairs, ignoring standard cookie attributes.
 */
export function parseCookies(raw: string): Array<ParsedCookie> {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return null;
      const name = part.substring(0, eqIdx).trim();
      const value = part.substring(eqIdx + 1).trim();
      // Skip cookie attributes that aren't name=value pairs
      if (!name || !value) return null;
      const lowerName = name.toLowerCase();
      if (
        ["path", "domain", "expires", "max-age", "secure", "httponly", "samesite"].includes(
          lowerName
        )
      ) {
        return null;
      }
      return { name, value };
    })
    .filter(Boolean) as Array<ParsedCookie>;
}

/**
 * Merge rotated __Secure-1PSID* cookies read back from a live cookie jar
 * or Set-Cookie headers into the original cookie string. Only the three long-lived
 * Gemini auth cookies are considered — pulling in the entire jar would risk
 * treating short-lived Google analytics/consent cookies as credentials (#7676).
 * Cookies the jar didn't return, or that are unchanged, are left untouched in the
 * original string.
 */
export function mergeRotatedGeminiCookies(
  originalCookie: string,
  jarCookies: Array<ParsedCookie>
): string {
  const jarByName = new Map(jarCookies.map((c) => [c.name, c.value]));

  const pairs = parseCookies(originalCookie);
  const seen = new Set<string>();
  const merged = pairs.map(({ name, value }) => {
    seen.add(name);
    if (
      (GEMINI_ROTATABLE_COOKIE_NAMES as readonly string[]).includes(name) &&
      jarByName.has(name)
    ) {
      return { name, value: jarByName.get(name) as string };
    }
    return { name, value };
  });

  for (const name of GEMINI_ROTATABLE_COOKIE_NAMES) {
    if (!seen.has(name) && jarByName.has(name)) {
      merged.push({ name, value: jarByName.get(name) as string });
    }
  }

  return merged.map(({ name, value }) => `${name}=${value}`).join("; ");
}
