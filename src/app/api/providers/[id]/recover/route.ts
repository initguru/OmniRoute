/**
 * POST /api/providers/[id]/recover
 *
 * Explicit user-triggered browser recovery endpoint for gemini-web connections.
 * Recovers session tokens and rotates cookies via headless Playwright, persisting
 * credentials using Compare-And-Swap (CAS) optimistic concurrency control.
 *
 * 🔒 LOCAL_ONLY — classified in `LOCAL_ONLY_API_PATTERNS` and `SPAWN_CAPABLE_PATTERNS`
 * (Hard Rules #15 + #17) because browser recovery launches headless Playwright
 * (a child process). Loopback gating runs unconditionally before any auth check.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnectionById, updateProviderConnectionCas } from "@/lib/db/providers";
// eslint-disable-next-line no-restricted-imports
import { recoverGeminiWebSessionWithBrowser } from "@omniroute/open-sse/executors/gemini-web/sessionRecovery.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const recoveryBodySchema = z
  .object({
    timeoutMs: z.number().int().min(5000).max(60000).optional(),
  })
  .strict();

export interface RecoveryRouteDependencies {
  recoverSession?: typeof recoverGeminiWebSessionWithBrowser;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  deps: RecoveryRouteDependencies = {}
): Promise<NextResponse> {
  const authError = await requireManagementAuth(request);
  if (authError) {
    return authError as unknown as NextResponse;
  }

  const { id } = await params;

  let bodyJson: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      bodyJson = JSON.parse(text);
    }
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = recoveryBodySchema.safeParse(bodyJson);
  if (!parseResult.success) {
    const formattedError = parseResult.error.issues.map((i) => i.message).join(", ");
    return NextResponse.json(
      { success: false, error: `Invalid request body: ${formattedError}` },
      { status: 400 }
    );
  }

  const { timeoutMs } = parseResult.data;

  try {
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json(
        { success: false, error: "Provider connection not found" },
        { status: 404 }
      );
    }

    if (connection.provider !== "gemini-web") {
      return NextResponse.json(
        { success: false, error: "Only gemini-web connections support browser recovery" },
        { status: 400 }
      );
    }

    const savedCookie = typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
    if (!savedCookie) {
      return NextResponse.json(
        { success: false, error: "Connection has no saved credentials (cookie) to recover" },
        { status: 400 }
      );
    }

    const recoverSession = deps.recoverSession ?? recoverGeminiWebSessionWithBrowser;
    const recovery = await recoverSession({
      cookie: savedCookie,
      timeoutMs,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });

    if (recovery.success) {
      if (recovery.mergedCookie && recovery.mergedCookie !== savedCookie) {
        const casResult = await updateProviderConnectionCas(
          id,
          { apiKey: recovery.mergedCookie },
          savedCookie
        );

        if (!casResult.updated || !casResult.connection) {
          return NextResponse.json(
            {
              success: false,
              error: "Concurrent credential update detected. Stale overwrite rejected.",
            },
            { status: 409 }
          );
        }
      }

      return NextResponse.json({
        success: true,
        status: "recovered",
        refreshedAt: new Date().toISOString(),
      });
    }

    // Handle authentication challenges / interactive login requirements
    if (
      recovery.error === "login_required" ||
      recovery.error?.includes("login_required") ||
      recovery.error?.includes("challenge") ||
      recovery.error?.includes("MFA")
    ) {
      return NextResponse.json({
        success: false,
        status: "login_required",
        requiresInteractiveLogin: true,
        error: "Google login required. Please log in interactively.",
      });
    }

    // Generic recovery failure (timeout, network, browser crash)
    const msg = sanitizeErrorMessage(recovery.error || "Session recovery failed");
    return NextResponse.json(
      { success: false, error: `Session recovery failed: ${msg}` },
      { status: 500 }
    );
  } catch (err) {
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: `Recovery endpoint error: ${msg}` },
      { status: 500 }
    );
  }
}
