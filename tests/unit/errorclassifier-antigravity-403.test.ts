import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderError,
  PROVIDER_ERROR_TYPES,
  classifyAntigravityCompatibilityError,
} from "../../open-sse/services/errorClassifier.ts";

// A Cloud Code / Antigravity (Gemini Code Assist) 403 is almost always a
// RECOVERABLE project-config problem — the Cloud AI Companion API not enabled on
// the project, a stale project, or PERMISSION_DENIED — NOT an account ban.
// It must classify as PROJECT_ROUTE_ERROR so the account stays usable once the
// project is fixed, instead of being disabled for ~a year like a real ban.

test("403 'has not been used in project' (antigravity) -> PROJECT_ROUTE_ERROR", () => {
  const body = {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Cloud AI Companion API has not been used in project 123 before or it is disabled.",
    },
  };
  assert.equal(
    classifyProviderError(403, body, "antigravity"),
    PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR
  );
});

test("403 SERVICE_DISABLED / PERMISSION_DENIED (gemini-cli) -> PROJECT_ROUTE_ERROR", () => {
  const body = {
    error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
  };
  assert.equal(
    classifyProviderError(403, body, "gemini-cli"),
    PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR
  );
});

test("403 on a cloud-code provider with a bare body -> still recoverable PROJECT_ROUTE_ERROR", () => {
  assert.equal(
    classifyProviderError(403, "forbidden", "antigravity-cloudcode"),
    PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR
  );
});

test("compatibility classifier preserves project route and account deactivated as distinct classes", () => {
  assert.equal(
    classifyAntigravityCompatibilityError(403, "has not been used in project", "antigravity"),
    "project_route"
  );
  assert.equal(
    classifyAntigravityCompatibilityError(
      403,
      "This service has been disabled in this account for violation of policy.",
      "antigravity"
    ),
    "auth_failure"
  );
});

test("ordinary Antigravity 401 responses classify as auth failures", () => {
  assert.equal(
    classifyAntigravityCompatibilityError(401, "Unauthorized", "antigravity"),
    "auth_failure"
  );
});

test("compatibility classifier gives schema precedence over quota text", () => {
  assert.equal(
    classifyAntigravityCompatibilityError(
      400,
      "INVALID_ARGUMENT: unknown field quotaType in request",
      "antigravity"
    ),
    "schema_rejection"
  );
});

test("compatibility classifier maps geo, quota, schema, and transport failures", () => {
  assert.equal(
    classifyAntigravityCompatibilityError(
      400,
      "User location is not supported for the API use.",
      "antigravity"
    ),
    "geo_eligibility"
  );
  assert.equal(
    classifyAntigravityCompatibilityError(429, "Individual quota reached", "antigravity"),
    "quota_rate_limit"
  );
  assert.equal(
    classifyAntigravityCompatibilityError(
      400,
      "Invalid JSON payload: unknown field",
      "antigravity"
    ),
    "schema_rejection"
  );
  assert.equal(
    classifyAntigravityCompatibilityError(503, "upstream unavailable", "antigravity"),
    "transport"
  );
});

test("403 real ban signal -> still ACCOUNT_DEACTIVATED (ban detection preserved)", () => {
  const body = "This service has been disabled in this account for violation of policy.";
  assert.equal(
    classifyProviderError(403, body, "antigravity"),
    PROVIDER_ERROR_TYPES.ACCOUNT_DEACTIVATED
  );
});
