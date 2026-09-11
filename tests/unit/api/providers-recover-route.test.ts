import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalOnlyPath,
  isLocalOnlyBypassableByManageScope,
} from "../../../src/server/authz/routeGuard.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import { updateSettings } from "../../../src/lib/db/settings.ts";
import {
  createProviderConnection,
  deleteProviderConnection,
  getProviderConnectionById,
} from "../../../src/lib/db/providers.ts";
import { POST } from "../../../src/app/api/providers/[id]/recover/route.ts";

describe("POST /api/providers/[id]/recover", () => {
  before(async () => {
    await updateSettings({ requireLogin: false });
  });

  after(() => {
    resetDbInstance();
  });

  describe("Route Guard & Loopback Gating (Hard Rules #15 + #17)", () => {
    it("marks /api/providers/[id]/recover as LOCAL_ONLY", () => {
      assert.equal(isLocalOnlyPath("/api/providers/test-id/recover"), true);
      assert.equal(isLocalOnlyPath("/api/providers/gemini-web-uuid/recover"), true);
      assert.equal(isLocalOnlyPath("/api/providers/gemini-web-uuid/recover/"), true);
    });

    it("rejects manage-scope bypass for /api/providers/[id]/recover (spawn-capable)", () => {
      assert.equal(isLocalOnlyBypassableByManageScope("/api/providers/test-id/recover"), false);
      assert.equal(isLocalOnlyBypassableByManageScope("/api/providers/test-id/recover/"), false);
    });

    it("does not over-match ordinary provider routes", () => {
      assert.equal(isLocalOnlyPath("/api/providers"), false);
      assert.equal(isLocalOnlyPath("/api/providers/test-id"), false);
      assert.equal(isLocalOnlyPath("/api/providers/test-id/test"), false);
      assert.equal(isLocalOnlyPath("/api/providers/test-id/models"), false);
      assert.equal(isLocalOnlyPath("/api/providers/test-id/recover/extra"), false);
    });
  });

  describe("Management Auth Enforcement", () => {
    it("rejects unauthenticated requests when management auth is enabled", async () => {
      const origPass = process.env.INITIAL_PASSWORD;
      try {
        await updateSettings({ requireLogin: true });
        process.env.INITIAL_PASSWORD = "test-management-password-xyz";

        const req = new Request("http://localhost:20128/api/providers/some-id/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(req, { params: Promise.resolve({ id: "some-id" }) });
        assert.ok(
          res.status === 401 || res.status === 403,
          `Expected 401 or 403, got ${res.status}`
        );
      } finally {
        if (origPass !== undefined) process.env.INITIAL_PASSWORD = origPass;
        else delete process.env.INITIAL_PASSWORD;
        await updateSettings({ requireLogin: false });
      }
    });
  });

  describe("Request Body Schema Validation (Strict)", () => {
    it("rejects unexpected keys with 400 Bad Request", async () => {
      const req = new Request("http://localhost:20128/api/providers/any-id/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: "attacker-supplied-cookie", unexpectedKey: 123 }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: "any-id" }) });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /invalid.*body|unrecognized/i);
    });

    it("rejects invalid timeoutMs (out of range or non-integer) with 400 Bad Request", async () => {
      // Too small (< 5000)
      const reqTooSmall = new Request("http://localhost:20128/api/providers/any-id/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMs: 4999 }),
      });
      const resTooSmall = await POST(reqTooSmall, { params: Promise.resolve({ id: "any-id" }) });
      assert.equal(resTooSmall.status, 400);

      // Too large (> 60000)
      const reqTooLarge = new Request("http://localhost:20128/api/providers/any-id/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMs: 60001 }),
      });
      const resTooLarge = await POST(reqTooLarge, { params: Promise.resolve({ id: "any-id" }) });
      assert.equal(resTooLarge.status, 400);

      // Non-integer
      const reqFloat = new Request("http://localhost:20128/api/providers/any-id/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMs: 10000.5 }),
      });
      const resFloat = await POST(reqFloat, { params: Promise.resolve({ id: "any-id" }) });
      assert.equal(resFloat.status, 400);
    });
  });

  describe("Provider Connection Pre-conditions", () => {
    it("returns 404 when provider connection is not found", async () => {
      const req = new Request("http://localhost:20128/api/providers/non-existent-uuid/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const res = await POST(req, { params: Promise.resolve({ id: "non-existent-uuid" }) });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /not found/i);
    });

    it("returns 400 when connection is not gemini-web", async () => {
      const conn = await createProviderConnection({
        provider: "openai",
        apiKey: "sk-openai-key",
      });
      assert.ok(conn?.id);
      const connId = conn.id as string;

      try {
        const req = new Request(`http://localhost:20128/api/providers/${connId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(req, { params: Promise.resolve({ id: connId }) });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /gemini-web/i);
      } finally {
        await deleteProviderConnection(connId);
      }
    });

    it("returns 400 when connection has no saved credentials", async () => {
      const conn = await createProviderConnection({
        provider: "gemini-web",
        apiKey: "",
      });
      assert.ok(conn?.id);
      const connId = conn.id as string;

      try {
        const req = new Request(`http://localhost:20128/api/providers/${connId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(req, { params: Promise.resolve({ id: connId }) });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /saved credentials/i);
      } finally {
        await deleteProviderConnection(connId);
      }
    });
  });

  describe("Execution, CAS Rotation, and Sanitization", () => {
    it("calls recoverGeminiWebSessionWithBrowser, updates DB via CAS, and returns sanitized response", async () => {
      const initialCookie = "__Secure-1PSID=test-sid; __Secure-1PSIDTS=initial-ts";
      const conn = await createProviderConnection({
        provider: "gemini-web",
        apiKey: initialCookie,
      });
      assert.ok(conn?.id);
      const connId = conn.id as string;

      try {
        const rotatedCookie = "__Secure-1PSID=test-sid; __Secure-1PSIDTS=rotated-ts-browser";
        const mockRecover = mock.fn(async (options: { cookie: string; timeoutMs?: number }) => {
          assert.equal(options.cookie, initialCookie);
          assert.equal(options.timeoutMs, 12000);
          return {
            success: true,
            tokens: {
              atToken: "test-at-token-value",
              fSid: "test-fsid-value",
              buildLabel: "boq_assistant-bard-web-server_20260907.07_p0",
            },
            mergedCookie: rotatedCookie,
          };
        });

        const req = new Request(`http://localhost:20128/api/providers/${connId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timeoutMs: 12000 }),
        });

        const res = await POST(
          req,
          { params: Promise.resolve({ id: connId }) },
          { recoverSession: mockRecover }
        );

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "recovered");
        assert.ok(data.refreshedAt);

        // Security check: response body must NEVER leak cookies, tokens, or auth secrets
        const rawResponseStr = JSON.stringify(data);
        assert.equal(rawResponseStr.includes("test-sid"), false);
        assert.equal(rawResponseStr.includes("rotated-ts"), false);
        assert.equal(rawResponseStr.includes("test-at-token"), false);
        assert.equal(rawResponseStr.includes("test-fsid"), false);

        // Verify DB was updated via CAS
        const updatedConn = await getProviderConnectionById(connId);
        assert.equal(updatedConn?.apiKey, rotatedCookie);
        assert.equal(mockRecover.mock.callCount(), 1);
      } finally {
        await deleteProviderConnection(connId);
      }
    });

    it("rejects stale overwrite on CAS mismatch without modifying DB", async () => {
      const initialCookie = "__Secure-1PSID=test-sid; __Secure-1PSIDTS=initial-ts";
      const conn = await createProviderConnection({
        provider: "gemini-web",
        apiKey: initialCookie,
      });
      assert.ok(conn?.id);
      const connId = conn.id as string;

      try {
        const concurrentCookie =
          "__Secure-1PSID=test-sid; __Secure-1PSIDTS=concurrently-updated-by-user";
        const mockRecover = mock.fn(async () => {
          // Simulate concurrent modification in DB during browser recovery run
          const { updateProviderConnection } = await import("../../../src/lib/db/providers.ts");
          await updateProviderConnection(connId, { apiKey: concurrentCookie });
          return {
            success: true,
            mergedCookie: "__Secure-1PSID=test-sid; __Secure-1PSIDTS=stale-rotated-from-browser",
          };
        });

        const req = new Request(`http://localhost:20128/api/providers/${connId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(
          req,
          { params: Promise.resolve({ id: connId }) },
          { recoverSession: mockRecover }
        );

        assert.equal(res.status, 409);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /concurrent|stale/i);

        // Verify DB still holds the newer operator credentials and was NOT clobbered
        const currentConn = await getProviderConnectionById(connId);
        assert.equal(currentConn?.apiKey, concurrentCookie);
      } finally {
        await deleteProviderConnection(connId);
      }
    });

    it("returns sanitized login_required / requiresInteractiveLogin on Google auth challenge", async () => {
      const initialCookie = "__Secure-1PSID=expired-cookie";
      const conn = await createProviderConnection({
        provider: "gemini-web",
        apiKey: initialCookie,
      });
      assert.ok(conn?.id);
      const connId = conn.id as string;

      try {
        const mockRecover = mock.fn(async () => ({
          success: false,
          error: "login_required",
        }));

        const req = new Request(`http://localhost:20128/api/providers/${connId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(
          req,
          { params: Promise.resolve({ id: connId }) },
          { recoverSession: mockRecover }
        );

        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.status, "login_required");
        assert.equal(data.requiresInteractiveLogin, true);
        assert.match(data.error, /login required/i);
      } finally {
        await deleteProviderConnection(connId);
      }
    });

    it("returns sanitized 500 error on browser launch failure without leaking stack traces", async () => {
      const initialCookie = "__Secure-1PSID=test-cookie";
      const conn = await createProviderConnection({
        provider: "gemini-web",
        apiKey: initialCookie,
      });
      assert.ok(conn?.id);
      const connId = conn.id as string;

      try {
        const mockRecover = mock.fn(async () => {
          throw new Error(
            "Chromium executable crashed at /usr/local/bin/chromium\n    at internal/process/task_queues:95:5"
          );
        });

        const req = new Request(`http://localhost:20128/api/providers/${connId}/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(
          req,
          { params: Promise.resolve({ id: connId }) },
          { recoverSession: mockRecover }
        );

        assert.equal(res.status, 500);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.ok(data.error);
        // Hard Rule #12: no raw stack traces in error messages
        assert.equal(data.error.includes("at /usr/"), false);
        assert.equal(data.error.includes("task_queues"), false);
      } finally {
        await deleteProviderConnection(connId);
      }
    });
  });
});
