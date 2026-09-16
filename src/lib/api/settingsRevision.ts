const SETTINGS_RESPONSE_HEADERS = { "Cache-Control": "no-store" } as const;

export function settingsResponseHeaders(settingsRevision: number): Record<string, string> {
  return {
    ...SETTINGS_RESPONSE_HEADERS,
    ETag: String(settingsRevision),
  };
}

function parseHeaderToken(ifMatch: string | null): {
  provided: boolean;
  valid: boolean;
  value?: number;
} {
  if (ifMatch === null) return { provided: false, valid: false };
  const trimmed = ifMatch.trim().replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "").trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return { provided: true, valid: true, value: parsed };
    }
  }
  return { provided: true, valid: false };
}

function parseBodyToken(body?: Record<string, unknown>): {
  provided: boolean;
  valid: boolean;
  value?: number;
} {
  if (!body || !("expectedRevision" in body) || body.expectedRevision === undefined) {
    return { provided: false, valid: false };
  }
  const val = body.expectedRevision;
  if (typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
    return { provided: true, valid: true, value: val };
  }
  return { provided: true, valid: false };
}

export function parseOptInExpectedRevision(
  request: Request,
  body?: Record<string, unknown>
): number | undefined {
  const header = parseHeaderToken(request.headers.get("If-Match"));
  if (header.provided && header.valid) return header.value;
  const bodyToken = parseBodyToken(body);
  if (bodyToken.provided && bodyToken.valid) return bodyToken.value;
  return undefined;
}

export type MandatoryRevisionResult =
  | { success: true; expectedRevision: number }
  | { success: false; error: { status: 400 | 428; code: string; message: string } };

export function parseMandatoryExpectedRevision(
  request: Request,
  body?: Record<string, unknown>
): MandatoryRevisionResult {
  const header = parseHeaderToken(request.headers.get("If-Match"));
  const bodyToken = parseBodyToken(body);

  if (header.provided && !header.valid) {
    return {
      success: false,
      error: {
        status: 400,
        code: "INVALID_EXPECTED_REVISION",
        message: "Malformed expected revision in If-Match header",
      },
    };
  }
  if (bodyToken.provided && !bodyToken.valid) {
    return {
      success: false,
      error: {
        status: 400,
        code: "INVALID_EXPECTED_REVISION",
        message: "Malformed expectedRevision in request body",
      },
    };
  }

  if (!header.provided && !bodyToken.provided) {
    return {
      success: false,
      error: {
        status: 428,
        code: "PRECONDITION_REQUIRED",
        message:
          "If-Match header or expectedRevision in body is required for system prompt updates",
      },
    };
  }

  if (header.provided && bodyToken.provided) {
    if (header.value !== bodyToken.value) {
      return {
        success: false,
        error: {
          status: 400,
          code: "INVALID_EXPECTED_REVISION",
          message: "Mismatch between If-Match header and body expectedRevision",
        },
      };
    }
    return { success: true, expectedRevision: header.value! };
  }

  if (header.provided) return { success: true, expectedRevision: header.value! };
  return { success: true, expectedRevision: bodyToken.value! };
}
