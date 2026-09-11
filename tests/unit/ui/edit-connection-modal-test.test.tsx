// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "gemini-web" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    notify: vi.fn(),
  }),
}));

vi.mock("@/store/emailPrivacyStore", () => ({
  default: (selector?: (state: any) => any) =>
    selector ? selector({ emailsVisible: false }) : false,
}));

vi.mock(
  "@/app/(dashboard)/dashboard/providers/[id]/components/modals/providerTierFieldApi",
  () => ({
    fetchProviderTierOverride: vi.fn().mockResolvedValue(""),
    saveProviderTierOverride: vi.fn().mockResolvedValue(undefined),
  })
);

const {
  default: EditConnectionModal,
  isMaskedCredential,
  isDraftCredentialDirty,
  shouldTestDraftCredential,
} = await import("../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal");

const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

function renderModal(props: Record<string, unknown>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(
      <EditConnectionModal
        isOpen
        providerId={(props.providerId as string) || "gemini-web"}
        connection={(props.connection as any) || null}
        onSave={(props.onSave as any) || vi.fn().mockResolvedValue(undefined)}
        onClose={(props.onClose as any) || vi.fn()}
        {...(props as any)}
      />
    );
  });
  containers.push({ root, el });
  return el;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("EditConnectionModal Test Contract & Draft/Saved Alignment", () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const { root, el } of containers.splice(0)) {
      act(() => root.unmount());
      el.remove();
    }
    vi.unstubAllGlobals();
  });

  describe("Helper unit assertions", () => {
    it("isMaskedCredential detects masked patterns correctly", () => {
      expect(isMaskedCredential("sk-1234****5678")).toBe(true);
      expect(isMaskedCredential("sk-1234***5678")).toBe(true);
      expect(isMaskedCredential("sk-1234...5678")).toBe(true);
      expect(isMaskedCredential("sk-1234…5678")).toBe(true);
      expect(isMaskedCredential("****")).toBe(true);
      expect(isMaskedCredential("")).toBe(false);
      expect(isMaskedCredential(null)).toBe(false);
      expect(isMaskedCredential(undefined)).toBe(false);
      expect(isMaskedCredential("sk-ant-api03-unmasked-token-123456789")).toBe(false);
      expect(isMaskedCredential("__Secure-1PSID=real-cookie-string-here")).toBe(false);
    });

    it("isDraftCredentialDirty identifies when draft is modified from saved", () => {
      expect(isDraftCredentialDirty("", "sk-saved****")).toBe(false);
      expect(isDraftCredentialDirty("   ", "sk-saved****")).toBe(false);
      expect(isDraftCredentialDirty("sk-saved****", "sk-saved****")).toBe(false);
      expect(isDraftCredentialDirty("sk-new-key", "sk-saved****")).toBe(true);
      expect(isDraftCredentialDirty("sk-new-key", "")).toBe(true);
      expect(isDraftCredentialDirty("sk-new-key", null)).toBe(true);
    });

    it("shouldTestDraftCredential correctly gates draft vs saved connection testing", () => {
      // Untouched: test saved connection
      expect(shouldTestDraftCredential("", "sk-saved****")).toBe(false);
      expect(shouldTestDraftCredential("   ", "sk-saved****")).toBe(false);

      // Masked: test saved connection
      expect(shouldTestDraftCredential("sk-saved****", "sk-saved****")).toBe(false);
      expect(shouldTestDraftCredential("sk-new****1234", "sk-saved****")).toBe(false);
      expect(shouldTestDraftCredential("sk-new...1234", "sk-saved****")).toBe(false);

      // Unmasked and modified: test draft credential
      expect(shouldTestDraftCredential("sk-new-valid-api-key", "sk-saved****")).toBe(true);
      expect(shouldTestDraftCredential("__Secure-1PSID=val123; __Secure-1PSIDTS=ts", "")).toBe(
        true
      );
    });
  });

  describe("handleTest execution flow", () => {
    it("tests saved connection via /api/providers/${connection.id}/test when apiKey is untouched", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/conn-1/test")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ valid: true }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: {
          id: "conn-1",
          provider: "gemini-web",
          apiKey: "sk-saved****4321",
        },
      });

      // Find "Test Connection" button
      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      expect(testBtn).toBeTruthy();

      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => fetchMock.mock.calls.length > 0);

      // Verify it called /api/providers/conn-1/test and NOT /api/providers/validate
      const testCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/providers/conn-1/test")
      );
      expect(testCall).toBeTruthy();

      const validateCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/providers/validate")
      );
      expect(validateCall).toBeUndefined();

      // Badge displays valid
      await waitFor(() => el.textContent?.includes("valid") ?? false);
      expect(el.textContent).toContain("valid");
    });

    it("evaluates draft credential via /api/providers/validate when apiKey is modified and unmasked", async () => {
      const onSaveMock = vi.fn();
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/validate")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                valid: true,
                providerSpecificData: { verifiedTier: "pro" },
              }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: {
          id: "conn-2",
          provider: "gemini-web",
          apiKey: "cookie****old",
        },
        onSave: onSaveMock,
      });

      // User types a fresh unmasked draft credential
      const apiKeyInput = el.querySelector<HTMLInputElement>('input[type="password"]')!;
      expect(apiKeyInput).toBeTruthy();
      setInputValue(apiKeyInput, "__Secure-1PSID=fresh-psid-token; __Secure-1PSIDTS=ts123");

      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      expect(testBtn).toBeTruthy();

      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => fetchMock.mock.calls.length > 0);

      // Verify it called /api/providers/validate with draft credential and NOT /api/providers/conn-2/test
      const validateCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/providers/validate")
      );
      expect(validateCall).toBeTruthy();
      const validateBody = JSON.parse(validateCall![1]?.body as string);
      expect(validateBody.apiKey).toBe("__Secure-1PSID=fresh-psid-token; __Secure-1PSIDTS=ts123");
      expect(validateBody.provider).toBe("gemini-web");

      const testCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/providers/conn-2/test")
      );
      expect(testCall).toBeUndefined();

      // Read-only evaluation: onSave must NOT have been called
      expect(onSaveMock).not.toHaveBeenCalled();

      // Shows valid badge
      await waitFor(() => el.textContent?.includes("valid") ?? false);
      expect(el.textContent).toContain("valid");
    });

    it("surfaces upstream authentication error on draft validation failure without misleading 'Missing credential'", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/validate")) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () =>
              Promise.resolve({
                error: "Invalid API key or expired web session cookie",
              }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: {
          id: "conn-3",
          provider: "gemini-web",
          apiKey: "",
        },
      });

      const apiKeyInput = el.querySelector<HTMLInputElement>('input[type="password"]')!;
      setInputValue(apiKeyInput, "__Secure-1PSID=invalid-expired-cookie");

      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => el.textContent?.includes("failed") ?? false);

      // Verify error badge is upstream auth error, NOT missing credential
      expect(el.textContent).toContain("errorTypeUpstreamAuth");
      expect(el.textContent).not.toContain("errorTypeMissingCredential");
      expect(el.textContent).toContain("Invalid API key or expired web session cookie");
    });

    it("handles network failure cleanly during draft validation", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/validate")) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: {
          id: "conn-4",
          provider: "gemini-web",
          apiKey: "",
        },
      });

      const apiKeyInput = el.querySelector<HTMLInputElement>('input[type="password"]')!;
      setInputValue(apiKeyInput, "sk-test-draft-key");

      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => el.textContent?.includes("failed") ?? false);

      expect(el.textContent).toContain("errorTypeNetworkError");
      expect(el.textContent).toContain("failedTestConnection");
    });

    it("treats masked draft key as untouched and tests saved DB row", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/conn-masked/test")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ valid: true }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: {
          id: "conn-masked",
          provider: "gemini-web",
          apiKey: "sk-saved****4321",
        },
      });

      // User pastes masked key
      const apiKeyInput = el.querySelector<HTMLInputElement>('input[type="password"]')!;
      setInputValue(apiKeyInput, "sk-saved****4321");

      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => fetchMock.mock.calls.length > 0);

      // Must call /test on the saved connection, NOT /api/providers/validate
      expect(fetchMock).toHaveBeenCalledWith("/api/providers/conn-masked/test", expect.anything());
      const validateCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/api/providers/validate")
      );
      expect(validateCall).toBeUndefined();
    });

    it("surfaces rate-limited diagnosis when validator returns 429", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/validate")) {
          return Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ error: "Rate limit exceeded" }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: { id: "conn-5", provider: "gemini-web", apiKey: "" },
      });

      const apiKeyInput = el.querySelector<HTMLInputElement>('input[type="password"]')!;
      setInputValue(apiKeyInput, "sk-rate-limited-key");

      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => el.textContent?.includes("errorTypeRateLimited") ?? false);
      expect(el.textContent).toContain("errorTypeRateLimited");
      expect(el.textContent).toContain("Rate limit exceeded");
    });

    it("surfaces unsupported diagnosis when validator returns unsupported: true", async () => {
      const fetchMock = vi.fn((url: string) => {
        if (String(url).includes("/api/providers/validate")) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () =>
              Promise.resolve({
                error: "Provider validation not supported",
                unsupported: true,
              }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      });
      vi.stubGlobal("fetch", fetchMock);

      const el = renderModal({
        providerId: "gemini-web",
        connection: { id: "conn-6", provider: "gemini-web", apiKey: "" },
      });

      const apiKeyInput = el.querySelector<HTMLInputElement>('input[type="password"]')!;
      setInputValue(apiKeyInput, "sk-unsupported-provider-key");

      const testBtn = Array.from(el.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("testConnection")
      );
      act(() => {
        testBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => el.textContent?.includes("errorTypeTestUnsupported") ?? false);
      expect(el.textContent).toContain("errorTypeTestUnsupported");
    });
  });
});
