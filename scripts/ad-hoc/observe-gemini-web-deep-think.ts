/**
 * Test clicking 3.1 Pro menu item and observing postcondition and thinking option.
 */

import { chromium } from "playwright";
import { getProviderCredentials } from "../../src/sse/services/auth.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { normalizeGeminiCookieInput } from "../../open-sse/utils/geminiCookies.ts";

function parseCookies(cookieStr: string) {
  return cookieStr
    .split(";")
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return null;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name || !value) return null;
      return { name, value };
    })
    .filter(Boolean) as Array<{ name: string; value: string }>;
}

async function main() {
  let cookie = "";
  try {
    const creds = await getProviderCredentials("gemini-web");
    if (creds?.apiKey) {
      cookie = normalizeGeminiCookieInput(creds.apiKey);
    }
  } finally {
    resetDbInstance();
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      locale: "en-US",
    });

    const cookiePairs = parseCookies(cookie);
    await context.addCookies(
      cookiePairs.map(({ name, value }) => ({
        name,
        value,
        domain: ".google.com",
        path: "/",
        secure: true,
      }))
    );

    const page = await context.newPage();
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const modePickerButton = page.locator("button[aria-label*='Open mode picker' i]").first();
    await modePickerButton.click();
    await page.waitForTimeout(1000);

    // Click 3.1 Pro
    const proItem = page.locator("[role='menuitem']").filter({ hasText: "3.1 Pro" }).first();
    console.log("CLICKING_PRO_ITEM...");
    await proItem.click();
    await page.waitForTimeout(2000);

    // Check button label after click
    const afterLabel = await modePickerButton.getAttribute("aria-label");
    const afterText = await modePickerButton.innerText();
    console.log(`AFTER_PRO_CLICK: text="${afterText.trim()}", aria="${afterLabel}"`);

    // Check if sign-in modal appeared or URL changed
    const currentUrl = page.url();
    console.log("URL_AFTER_CLICK:", currentUrl);

    // Check all dialogs or popups
    const dialogs = await page.locator("[role='dialog'], mat-dialog-container").all();
    console.log("DIALOGS_COUNT:", dialogs.length);
    for (const d of dialogs) {
      const text = await d.innerText();
      console.log("DIALOG_TEXT:", text.slice(0, 150));
    }

    // Check if thinking controls / deep think toggle appeared anywhere in DOM
    const thinkElements = await page.locator("*").filter({ hasText: /deep think|thinking/i }).all();
    console.log("THINK_ELEMENTS_COUNT:", thinkElements.length);
    for (let i = 0; i < Math.min(thinkElements.length, 5); i++) {
      const tag = await thinkElements[i].evaluate((el) => el.tagName.toLowerCase());
      const txt = await thinkElements[i].innerText().catch(() => "");
      console.log(`THINK_EL[${i}]: <${tag}> "${txt.slice(0, 80)}"`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
