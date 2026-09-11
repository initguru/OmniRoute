import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("gemini-web autoRefreshDaemon boot wiring (src/instrumentation-node.ts)", () => {
  it("registers active gemini-web connections with autoRefreshDaemon on boot", async () => {
    const { initGeminiWebAutoRefresh } = await import("../../src/instrumentation-node.ts");

    assert.equal(
      typeof initGeminiWebAutoRefresh,
      "function",
      "initGeminiWebAutoRefresh must be exported from instrumentation-node.ts"
    );

    const { autoRefreshDaemon } = await import("../../open-sse/services/autoRefreshDaemon.ts");

    const registeredCalls: Array<{
      providerId: string;
      value: string;
      onRefreshed?: (val: string) => Promise<void> | void;
    }> = [];

    const originalRegister = autoRefreshDaemon.registerCredential.bind(autoRefreshDaemon);
    autoRefreshDaemon.registerCredential = (providerId, value, onRefreshed) => {
      registeredCalls.push({ providerId, value, onRefreshed });
    };

    const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];

    const mockGetRaw = async (filter?: Record<string, unknown>) => {
      assert.equal(filter?.provider, "gemini-web");
      return [
        { id: "active-conn-1", provider: "gemini-web", apiKey: "cookie-123", isActive: 1 },
        { id: "inactive-conn-2", provider: "gemini-web", apiKey: "cookie-456", isActive: 0 },
        { id: "no-key-conn-3", provider: "gemini-web", apiKey: "", isActive: 1 },
      ];
    };

    const mockUpdate = async (id: string, data: Record<string, unknown>) => {
      updateCalls.push({ id, data });
      return { id, ...data };
    };

    try {
      await initGeminiWebAutoRefresh({
        getRawProviderConnections: mockGetRaw,
        updateProviderConnection: mockUpdate,
      });

      assert.equal(registeredCalls.length, 1);
      assert.equal(registeredCalls[0].providerId, "gemini-web");
      assert.equal(registeredCalls[0].value, "cookie-123");

      // Verify onRefreshed callback updates the connection
      assert.ok(registeredCalls[0].onRefreshed);
      await registeredCalls[0].onRefreshed("rotated-cookie-789");

      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0].id, "active-conn-1");
      assert.deepEqual(updateCalls[0].data, { apiKey: "rotated-cookie-789" });

      // Check if source code has the wiring logic
      const fs = await import("node:fs");
      const source = fs.readFileSync(
        new URL("../../src/instrumentation-node.ts", import.meta.url),
        "utf8"
      );

      assert.match(source, /getRawProviderConnections/, "Must query getRawProviderConnections");
      assert.match(
        source,
        /autoRefreshDaemon\.registerCredential\(\s*["']gemini-web["']/,
        "Must call autoRefreshDaemon.registerCredential with gemini-web"
      );
    } finally {
      autoRefreshDaemon.registerCredential = originalRegister;
    }
  });
});

describe("gemini-web autoRefreshDaemon route wiring (src/app/api/providers/[id]/route.ts)", () => {
  it("registers updated apiKey with autoRefreshDaemon when gemini-web connection is updated", async () => {
    const fs = await import("node:fs");
    const routeSource = fs.readFileSync(
      new URL("../../src/app/api/providers/[id]/route.ts", import.meta.url),
      "utf8"
    );

    assert.match(
      routeSource,
      /autoRefreshDaemon\.registerCredential\(\s*["']gemini-web["']/,
      "Must register gemini-web with autoRefreshDaemon on provider update"
    );
    assert.match(
      routeSource,
      /updateData\.apiKey\s*\|\|\s*existing\.apiKey/,
      "Must use updateData.apiKey || existing.apiKey"
    );
  });
});
