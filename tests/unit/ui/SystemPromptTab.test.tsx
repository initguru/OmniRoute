// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SystemPromptTab from "@/app/(dashboard)/dashboard/settings/components/SystemPromptTab";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "chars" && values?.count !== undefined) {
      return `${values.count} chars`;
    }
    return key;
  },
}));

type PutCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

let serverState = {
  enabled: true,
  prefixPrompt: "Initial Prefix",
  suffixPrompt: "Initial Suffix",
  settingsRevision: 10,
};

let putCalls: PutCall[] = [];
let getCallCount = 0;
let putDelayPromise: Promise<Response> | null = null;
let mockPutResponse: Response | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  serverState = {
    enabled: true,
    prefixPrompt: "Initial Prefix",
    suffixPrompt: "Initial Suffix",
    settingsRevision: 10,
  };
  putCalls = [];
  getCallCount = 0;
  putDelayPromise = null;
  mockPutResponse = null;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/settings/system-prompt")) {
      if (init?.method === "PUT") {
        const headers: Record<string, string> = {};
        if (init.headers) {
          new Headers(init.headers).forEach((v, k) => {
            headers[k] = v;
          });
        }
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        putCalls.push({ url, method: "PUT", headers, body });

        if (mockPutResponse) {
          const res = mockPutResponse;
          return res;
        }

        if (putDelayPromise) {
          return putDelayPromise;
        }

        // Default behavior: increment revision and return updated state
        serverState = {
          enabled: Boolean(body.enabled),
          prefixPrompt: String(body.prefixPrompt ?? ""),
          suffixPrompt: String(body.suffixPrompt ?? ""),
          settingsRevision: serverState.settingsRevision + 1,
        };
        return new Response(JSON.stringify(serverState), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: String(serverState.settingsRevision),
          },
        });
      }

      // GET
      getCallCount++;
      return new Response(JSON.stringify(serverState), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: String(serverState.settingsRevision),
        },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

const containers: HTMLElement[] = [];
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  while (containers.length > 0) {
    containers.pop()?.remove();
  }
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderComponent() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  root = createRoot(container);
  act(() => {
    root?.render(<SystemPromptTab />);
  });
  return container;
}

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe("SystemPromptTab UI state machine and concurrency", () => {
  it("initial load syncs persisted snapshot and revision", async () => {
    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    expect(getCallCount).toBe(1);
    const textareas = container.querySelectorAll("textarea");
    expect(textareas.length).toBe(2);
    expect((textareas[0] as HTMLTextAreaElement).value).toBe("Initial Prefix");
    expect((textareas[1] as HTMLTextAreaElement).value).toBe("Initial Suffix");
    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("first text input does NOT disable prompt (Stale-Ref Regression Guard)", async () => {
    serverState = {
      enabled: true,
      prefixPrompt: "Existing",
      suffixPrompt: "",
      settingsRevision: 5,
    };

    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    expect(prefixTextarea.value).toBe("Existing");

    // Simulate focus
    act(() => {
      prefixTextarea.focus();
    });

    // Simulate typing "A"
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeInputValueSetter?.call(prefixTextarea, "ExistingA");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Advance 800ms debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    expect(putCalls.length).toBe(1);
    const call = putCalls[0];
    // Must NOT disable prompt! enabled must remain true!
    expect(call.body.enabled).toBe(true);
    expect(call.body.prefixPrompt).toBe("ExistingA");
    expect(call.body.suffixPrompt).toBe("");
    expect(call.body.expectedRevision).toBe(5);
    expect(call.headers["if-match"]).toBe("5");
  });

  it("interaction discrimination: first focus alone does not trigger save or disable", async () => {
    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      prefixTextarea.focus();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
    });

    expect(putCalls.length).toBe(0);
  });

  it("remount recurrence guard: unmounting and remounting retains enabled: true on edit", async () => {
    serverState = {
      enabled: true,
      prefixPrompt: "Mounted1",
      suffixPrompt: "",
      settingsRevision: 7,
    };

    let container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    // Unmount
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();

    // Remount
    container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(prefixTextarea, "Mounted2");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    expect(putCalls.length).toBe(1);
    expect(putCalls[0].body.enabled).toBe(true);
    expect(putCalls[0].body.prefixPrompt).toBe("Mounted2");
    expect(putCalls[0].body.expectedRevision).toBe(7);
  });

  it("toggle click cancels active debounce timer and sends immediate full canonical PUT", async () => {
    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(prefixTextarea, "Typing before toggle");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Toggle immediately before 800ms expires
    const toggle = container.querySelector('button[role="switch"]') as HTMLButtonElement;
    act(() => {
      toggle.click();
    });

    await act(async () => {
      await flushPromises();
    });

    // Only ONE PUT sent immediately, debounce timer was cancelled
    expect(putCalls.length).toBe(1);
    expect(putCalls[0].body.enabled).toBe(false);
    expect(putCalls[0].body.prefixPrompt).toBe("Typing before toggle");
    expect(putCalls[0].body.expectedRevision).toBe(10);

    // Advance 1000ms more to ensure cancelled debounce timer does not fire a second PUT
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
    });
    expect(putCalls.length).toBe(1);
  });

  it("serialized queue coalesces rapid typing and executes sequentially without parallel PUTs", async () => {
    let pendingResolve: ((r: Response) => void) | null = null;
    putDelayPromise = new Promise((resolve) => {
      pendingResolve = resolve;
    });

    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    // First keystroke -> triggers first debounce
    act(() => {
      nativeSetter?.call(prefixTextarea, "Text1");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    expect(putCalls.length).toBe(1);
    expect(putCalls[0].body.prefixPrompt).toBe("Text1");

    // While first PUT is in flight, user types Text2 and Text3 rapidly
    act(() => {
      nativeSetter?.call(prefixTextarea, "Text2");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => {
      nativeSetter?.call(prefixTextarea, "Text3");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    // Still only 1 in-flight PUT (serialized, no parallel dispatch)
    expect(putCalls.length).toBe(1);

    // Resolve first PUT
    putDelayPromise = null;
    await act(async () => {
      pendingResolve?.(
        new Response(
          JSON.stringify({
            enabled: true,
            prefixPrompt: "Text1",
            suffixPrompt: "Initial Suffix",
            settingsRevision: 11,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: "11" },
          }
        )
      );
      await flushPromises();
    });

    // Queue drained: second PUT dispatched with coalesced Text3 and NEW revision 11!
    expect(putCalls.length).toBe(2);
    expect(putCalls[1].body.prefixPrompt).toBe("Text3");
    expect(putCalls[1].body.expectedRevision).toBe(11);
    expect(putCalls[1].headers["if-match"]).toBe("11");
  });

  it("stale 200 response does not clobber user newer draft or cursor", async () => {
    let pendingResolve: ((r: Response) => void) | null = null;
    putDelayPromise = new Promise((resolve) => {
      pendingResolve = resolve;
    });

    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    act(() => {
      nativeSetter?.call(prefixTextarea, "First Edit");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    // While in flight, user types more
    act(() => {
      nativeSetter?.call(prefixTextarea, "First Edit - More Words");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
      // Set selection cursor to verify it is not clobbered
      prefixTextarea.setSelectionRange(12, 16);
    });

    expect(prefixTextarea.selectionStart).toBe(12);
    expect(prefixTextarea.selectionEnd).toBe(16);

    putDelayPromise = null;
    await act(async () => {
      pendingResolve?.(
        new Response(
          JSON.stringify({
            enabled: true,
            prefixPrompt: "First Edit",
            suffixPrompt: "Initial Suffix",
            settingsRevision: 11,
          }),
          { status: 200, headers: { ETag: "11" } }
        )
      );
      await flushPromises();
    });

    // The textarea content must NOT revert to "First Edit"! It must preserve "First Edit - More Words"!
    expect(prefixTextarea.value).toBe("First Edit - More Words");
    // Selection and cursor must remain intact and not clobbered
    expect(prefixTextarea.selectionStart).toBe(12);
    expect(prefixTextarea.selectionEnd).toBe(16);
  });

  it("428 precondition required stops automatic retry, preserves draft, and renders conflict banner with reload button", async () => {
    mockPutResponse = new Response(
      JSON.stringify({
        error: {
          code: "PRECONDITION_REQUIRED",
          message: "Precondition Required",
        },
      }),
      { status: 428 }
    );

    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(prefixTextarea, "Draft awaiting precondition");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    // Conflict banner rendered
    expect(container.textContent).toContain("systemPromptConflictTitle");
    expect(container.textContent).toContain("systemPromptConflictDesc");

    // Draft is preserved
    expect(prefixTextarea.value).toBe("Draft awaiting precondition");

    // Explicit reload button exists
    const reloadButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("systemPromptConflictReload")
    );
    expect(reloadButton).toBeDefined();

    // No infinite retry loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
    });
    expect(putCalls.length).toBe(1);
  });

  it("unmount cleanup regression: owned pending 800ms debounce never emits a delayed PUT after unmount", async () => {
    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(prefixTextarea, "Pending edit before unmount");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Advance 400ms (debounce timer active and pending)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await flushPromises();
    });
    expect(putCalls.length).toBe(0);

    // Unmount component while debounce is pending
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();

    // Advance 1000ms past the 800ms threshold
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromises();
    });

    // Proves unmount cleanup cleared debounce timer and never emitted delayed PUT
    expect(putCalls.length).toBe(0);
  });

  it("409 conflict stops automatic retry, preserves draft, and renders conflict banner with reload button", async () => {
    // Return 409 conflict on PUT
    mockPutResponse = new Response(
      JSON.stringify({
        error: {
          code: "SETTINGS_REVISION_CONFLICT",
          message: "Settings changed since this snapshot; refresh and retry",
          currentRevision: 15,
        },
      }),
      { status: 409, headers: { ETag: "15" } }
    );

    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(prefixTextarea, "Conflicting draft");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    // Conflict banner rendered
    expect(container.textContent).toContain("systemPromptConflictTitle");
    expect(container.textContent).toContain("systemPromptConflictDesc");

    // Draft is preserved
    expect(prefixTextarea.value).toBe("Conflicting draft");

    // No infinite retry loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
    });
    expect(putCalls.length).toBe(1);
  });

  it("clicking reload button re-fetches latest server state", async () => {
    // First call gives conflict
    mockPutResponse = new Response(
      JSON.stringify({
        error: {
          code: "SETTINGS_REVISION_CONFLICT",
          currentRevision: 15,
        },
      }),
      { status: 409, headers: { ETag: "15" } }
    );

    const container = renderComponent();
    await act(async () => {
      await flushPromises();
    });

    const prefixTextarea = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(prefixTextarea, "Draft");
      prefixTextarea.dispatchEvent(new Event("input", { bubbles: true }));
      prefixTextarea.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
    });

    expect(container.textContent).toContain("systemPromptConflictTitle");

    // Clear conflict response and update server state for reload
    mockPutResponse = null;
    serverState = {
      enabled: true,
      prefixPrompt: "Server Fresh State",
      suffixPrompt: "Server Fresh Suffix",
      settingsRevision: 15,
    };

    // Find and click reload button
    const reloadButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("systemPromptConflictReload")
    );
    expect(reloadButton).toBeDefined();

    act(() => {
      reloadButton?.click();
    });

    await act(async () => {
      await flushPromises();
    });

    // Conflict banner cleared and text reloaded from server
    expect(container.textContent).not.toContain("systemPromptConflictTitle");
    const updatedTextareas = container.querySelectorAll("textarea");
    expect((updatedTextareas[0] as HTMLTextAreaElement).value).toBe("Server Fresh State");
    expect((updatedTextareas[1] as HTMLTextAreaElement).value).toBe("Server Fresh Suffix");
  });
});
