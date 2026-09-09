import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAntigravityCompatibilityEvent,
  type AntigravityCompatibilityEvent,
} from "../../open-sse/services/antigravityCompatibilityDiagnostics.ts";
import {
  sendAntigravityRequest,
  toSafeAntigravityLog,
  tryCreditsRetry,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";
import type { AntigravityClientContext } from "../../open-sse/config/antigravityClient.ts";
import type { AntigravityCredentials } from "../../open-sse/executors/antigravity.ts";

const CONTEXT: AntigravityClientContext = {
  profile: "cli",
  contractId: "antigravity-wire-cli-synthetic-v1",
  observedVersion: null,
  versionState: "unverified",
  source: "provider-default",
};

const CREDENTIALS: AntigravityCredentials = {
  accessToken: "synthetic-access-token",
  projectId: "synthetic-project",
};

function createEventLog(): {
  events: AntigravityCompatibilityEvent[];
  log: ReturnType<typeof toSafeAntigravityLog>;
} {
  const events: AntigravityCompatibilityEvent[] = [];
  return {
    events,
    log: toSafeAntigravityLog({
      debug: (tag, message) => {
        if (tag === "AG_COMPATIBILITY")
          events.push(JSON.parse(message) as AntigravityCompatibilityEvent);
      },
    }),
  };
}

function buildEvent(
  bodyShape: unknown,
  headerNames: readonly string[] = []
): AntigravityCompatibilityEvent {
  return buildAntigravityCompatibilityEvent({
    context: CONTEXT,
    surface: "content",
    requestType: "agent",
    attempt: 1,
    errorClass: "schema_rejection",
    retryDecision: "none",
    bodyShape,
    headerNames,
    durationMs: 17,
  });
}

test("compatibility event never retains raw body, project, prompt, identity, or credential values", () => {
  const prompt = "TOP_SECRET_PROMPT_VALUE_8d3f";
  const project = "sensitive-project-42";
  const session = "machine-session-9f8e";
  const authorization = "Bearer secret-token-value";
  const bodyShape = {
    model: "gemini-3.1-pro",
    project,
    requestId: session,
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ functionDeclarations: [{ name: "read_file" }] }],
      sessionId: session,
    },
    authorization,
  };

  const event = buildEvent(bodyShape, [
    "Authorization",
    "Cookie",
    "x-goog-user-project",
    "content-type",
  ]);
  const serialized = JSON.stringify(event);

  assert.doesNotMatch(serialized, new RegExp(prompt));
  assert.doesNotMatch(serialized, new RegExp(project));
  assert.doesNotMatch(serialized, new RegExp(session));
  assert.doesNotMatch(serialized, new RegExp(authorization.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /authorization|cookie|secret-token-value|sessionid/i);
  assert.match(event.redactedBodyDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.match(event.redactedHeaderDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    Object.keys(event).sort().join(","),
    [
      "attempt",
      "contractId",
      "durationMs",
      "errorClass",
      "event",
      "observedVersion",
      "profile",
      "provider",
      "redactedBodyDigest",
      "redactedHeaderDigest",
      "requestType",
      "retryDecision",
      "surface",
      "versionState",
    ]
      .sort()
      .join(",")
  );
});

test("same allowlisted structural shape produces a stable digest without copying values", () => {
  const first = buildEvent(
    {
      model: "gemini-3.1-pro",
      requestType: "agent",
      stream: true,
      request: {
        contents: [{ role: "user", parts: [{ text: "first prompt" }] }],
        tools: [{ functionDeclarations: [{ name: "first_tool" }] }],
        generationConfig: { maxOutputTokens: 128 },
      },
      project: "project-one",
    },
    ["content-type", "accept"]
  );
  const second = buildEvent(
    {
      model: "gemini-2.5-flash",
      requestType: "agent",
      stream: true,
      request: {
        contents: [{ role: "user", parts: [{ text: "second prompt" }] }],
        tools: [{ functionDeclarations: [{ name: "second_tool" }] }],
        generationConfig: { maxOutputTokens: 4096 },
      },
      project: "project-two",
    },
    ["accept", "content-type"]
  );

  assert.equal(first.provider, "antigravity");
  assert.equal(first.redactedBodyDigest, second.redactedBodyDigest);
  assert.equal(first.redactedHeaderDigest, second.redactedHeaderDigest);
  assert.notEqual(first.redactedBodyDigest, null);
  assert.notEqual(first.redactedHeaderDigest, null);
});

test("different allowlisted structural shape produces a different body digest", () => {
  const oneContent = buildEvent({
    model: "gemini-3.1-pro",
    request: {
      contents: [{ role: "user", parts: [{ text: "same" }] }],
      tools: [{ functionDeclarations: [] }],
    },
    stream: true,
  });
  const twoContents = buildEvent({
    model: "gemini-3.1-pro",
    request: {
      contents: [
        { role: "user", parts: [{ text: "same" }] },
        { role: "model", parts: [{ text: "same" }] },
      ],
      tools: [],
    },
    stream: false,
  });

  assert.notEqual(oneContent.redactedBodyDigest, twoContents.redactedBodyDigest);
});

test("header digest is order-stable, distinguishes safe shape, and excludes sensitive names", () => {
  const first = buildEvent({ model: "claude-sonnet", request: { contents: [] } }, [
    "User-Agent",
    "Content-Type",
    "Authorization",
  ]);
  const reordered = buildEvent({ model: "claude-sonnet", request: { contents: [] } }, [
    "authorization",
    "content-type",
    "user-agent",
  ]);
  const different = buildEvent({ model: "claude-sonnet", request: { contents: [] } }, [
    "User-Agent",
    "Accept",
  ]);

  assert.equal(first.redactedHeaderDigest, reordered.redactedHeaderDigest);
  assert.notEqual(first.redactedHeaderDigest, different.redactedHeaderDigest);
  assert.doesNotMatch(JSON.stringify(first), /authorization/i);
});

test("compatibility classifier precedence keeps invalid quota text as schema rejection", async () => {
  const { events, log } = createEventLog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "invalid quota field" } }),
      { status: 400 }
    );
  try {
    await sendAntigravityRequest(
      "antigravity",
      "https://synthetic.invalid/content",
      "gemini-2.5-flash",
      { "content-type": "application/json" },
      { project: "synthetic-project", request: { contents: [] }, requestType: "agent" },
      CREDENTIALS,
      true,
      undefined,
      log,
      0,
      CONTEXT
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(events.at(-1)?.errorClass, "schema_rejection");
});

test("content transport failures emit a redacted transport event before propagating", async () => {
  const { events, log } = createEventLog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("synthetic transport failure");
  };
  try {
    await assert.rejects(
      sendAntigravityRequest(
        "antigravity",
        "https://synthetic.invalid/content?token=secret",
        "gemini-2.5-flash",
        { "content-type": "application/json" },
        { project: "synthetic-project", request: { contents: [] }, requestType: "agent" },
        CREDENTIALS,
        true,
        undefined,
        log,
        0,
        CONTEXT
      ),
      /synthetic transport failure/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(events.at(-1)?.errorClass, "transport");
  assert.doesNotMatch(JSON.stringify(events), /synthetic transport failure|secret/);
});

test("project-header retry classifies account auth failures and final retry metadata", async () => {
  const { events, log } = createEventLog();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: {
          status: "PERMISSION_DENIED",
          message: "This service has been disabled in this account for violation of policy.",
        },
      }),
      { status: 403 }
    );
  };
  try {
    await sendAntigravityRequest(
      "antigravity",
      "https://synthetic.invalid/content",
      "gemini-2.5-flash",
      { "content-type": "application/json", "x-goog-user-project": "synthetic-project" },
      { project: "synthetic-project", request: { contents: [] }, requestType: "agent" },
      CREDENTIALS,
      true,
      undefined,
      log,
      0,
      CONTEXT
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
  assert.equal(events[0]?.errorClass, "auth_failure");
  assert.equal(events[0]?.retryDecision, "project_header_retry");
  assert.equal(events.at(-1)?.errorClass, "auth_failure");
  assert.equal(events.at(-1)?.attempt, 2);
  assert.equal(events.at(-1)?.retryDecision, "project_header_retry");
});

test("refresh retry event records context without OAuth or request secrets", async () => {
  const { events, log } = createEventLog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /oauth2\.googleapis\.com\/token$/);
    return new Response(
      JSON.stringify({
        access_token: "refreshed-secret",
        refresh_token: "next-refresh-secret",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
    const executor = new AntigravityExecutor();
    const result = await executor.refreshCredentials(
      {
        refreshToken: "refresh-secret",
        accessToken: "old-access-secret",
        projectId: "project-secret",
        providerSpecificData: { clientProfile: "cli" },
      },
      log
    );
    assert.equal(result?.accessToken, "refreshed-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(events.at(-1)?.retryDecision, "refresh_retry");
  assert.equal(events.at(-1)?.surface, "oauth");
  assert.equal(events.at(-1)?.attempt, 1);
  assert.doesNotMatch(
    JSON.stringify(events),
    /refresh-secret|access-secret|project-secret|refreshed-secret|next-refresh-secret/
  );
});

test("response body classification reads only a bounded prefix before timing out", async () => {
  const { log } = createEventLog();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":{"message":"quota"}}'));
          // Deliberately never close: the classifier must use its own finite budget.
        },
      }),
      { status: 403 }
    );
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendAntigravityRequest(
        "antigravity",
        "https://synthetic.invalid/content",
        "gemini-2.5-flash",
        { "content-type": "application/json" },
        { project: "synthetic-project", request: { contents: [] }, requestType: "agent" },
        CREDENTIALS,
        true,
        undefined,
        log,
        0,
        CONTEXT
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("bounded body read timed out")), 750);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    globalThis.fetch = originalFetch;
  }
  assert.ok(Date.now() - startedAt < 750);
});

test("credits retry classifies non-429 response status without exposing its body", async () => {
  for (const [status, expected] of [
    [403, "auth_failure"],
    [500, "transport"],
  ] as const) {
    const { events, log } = createEventLog();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              status === 403
                ? "This service has been disabled in this account for violation of policy."
                : "upstream",
          },
        }),
        { status }
      );
    try {
      await tryCreditsRetry(
        "antigravity",
        "https://synthetic.invalid/credits",
        { "content-type": "application/json" },
        { project: "synthetic-project", request: { contents: [] }, requestType: "agent" },
        CREDENTIALS,
        true,
        undefined,
        log,
        "synthetic-account",
        () => {},
        CONTEXT
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(events.at(-1)?.errorClass, expected);
    assert.doesNotMatch(
      JSON.stringify(events),
      /disabled in this account|upstream|violation of policy/
    );
  }
});
