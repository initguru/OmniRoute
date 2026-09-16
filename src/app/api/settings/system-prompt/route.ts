import { NextResponse } from "next/server";
import {
  getSystemPromptSettingSnapshot,
  updateSettings,
  SettingsRevisionConflictError,
} from "@/lib/db/settings";
import { putSystemPromptSchema } from "@/shared/validation/schemas/settings";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  parseMandatoryExpectedRevision,
  settingsResponseHeaders,
} from "@/lib/api/settingsRevision";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    const snapshot = await getSystemPromptSettingSnapshot();
    return NextResponse.json(
      {
        ...snapshot.config,
        settingsRevision: snapshot.settingsRevision,
      },
      { headers: settingsResponseHeaders(snapshot.settingsRevision) }
    );
  } catch (error) {
    console.error("Error reading system prompt config:", error);
    return NextResponse.json({ error: "Failed to read system prompt config" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  let rawBody: Record<string, unknown>;
  try {
    rawBody = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_JSON",
          message: "Invalid JSON body",
        },
      },
      { status: 400 }
    );
  }

  const revisionResult = parseMandatoryExpectedRevision(request, rawBody);
  if (!revisionResult.success) {
    return NextResponse.json(
      {
        error: {
          code: revisionResult.error.code,
          message: revisionResult.error.message,
        },
      },
      { status: revisionResult.error.status }
    );
  }

  const validation = validateBody(putSystemPromptSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const body = validation.data;

  const { expectedRevision: _, ...canonicalPayload } = body;

  try {
    await updateSettings(
      { systemPrompt: canonicalPayload },
      { expectedRevision: revisionResult.expectedRevision }
    );
    const snapshot = await getSystemPromptSettingSnapshot();
    return NextResponse.json(
      {
        ...snapshot.config,
        settingsRevision: snapshot.settingsRevision,
      },
      { headers: settingsResponseHeaders(snapshot.settingsRevision) }
    );
  } catch (error) {
    if (error instanceof SettingsRevisionConflictError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: "Settings changed since this snapshot; refresh and retry",
            currentRevision: error.currentRevision,
          },
        },
        {
          status: 409,
          headers: settingsResponseHeaders(error.currentRevision),
        }
      );
    }
    console.error("Error updating system prompt config:", error);
    return NextResponse.json({ error: "Failed to update system prompt config" }, { status: 500 });
  }
}
