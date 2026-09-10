import test from "node:test";
import assert from "node:assert/strict";

import { gemini_webProvider } from "../../open-sse/config/providers/registry/gemini/web/index.ts";
import {
  checkGeminiWebUnsupportedControls,
  GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
} from "../../open-sse/executors/gemini-web/capabilities.ts";
import { supportsReasoning, supportsToolCalling } from "../../src/lib/modelCapabilities.ts";

test("gemini-web registry includes gemini-deep-think with reasoning and timeout", () => {
  const deepThink = gemini_webProvider.models.find((m) => m.id === "gemini-deep-think");
  assert.ok(deepThink, "gemini-deep-think must be registered in gemini_webProvider.models");
  assert.equal(deepThink.name, "Gemini Deep Think");
  assert.equal(deepThink.supportsReasoning, true, "gemini-deep-think supports reasoning");
  assert.equal(
    deepThink.toolCalling,
    false,
    "gemini-deep-think does not support native tool calling"
  );
  assert.equal(
    deepThink.timeoutMs,
    600_000,
    "gemini-deep-think timeoutMs must be 600,000 (10 minutes)"
  );
  assert.equal(
    gemini_webProvider.liveCatalogAuthoritative,
    false,
    "gemini-web must set liveCatalogAuthoritative: false to allow virtual models like gemini-deep-think"
  );

  assert.equal(
    supportsReasoning({ provider: "gemini-web", model: "gemini-deep-think" }),
    true,
    "resolved capability supportsReasoning must be true"
  );
  assert.equal(
    supportsToolCalling({ provider: "gemini-web", model: "gemini-deep-think" }),
    false,
    "resolved capability supportsToolCalling must be false"
  );
});

test("legacy gemini-web models continue to reject reasoning_effort: high", () => {
  const legacyModels = ["gemini-3.1-pro", "gemini-3.7-flash", "gemini-3.1-flash-lite"];

  for (const modelId of legacyModels) {
    const violation = checkGeminiWebUnsupportedControls({ reasoning_effort: "high" }, modelId);
    assert.equal(
      violation?.param,
      "reasoning_effort",
      `legacy model ${modelId} must reject reasoning_effort="high"`
    );
    assert.match(violation!.message, /reasoning_effort/);

    // Also verify legacy models allow none and minimal
    assert.equal(checkGeminiWebUnsupportedControls({ reasoning_effort: "none" }, modelId), null);
    assert.equal(checkGeminiWebUnsupportedControls({ reasoning_effort: "minimal" }, modelId), null);
    assert.equal(checkGeminiWebUnsupportedControls({}, modelId), null);
  }

  // Model-omitted call still behaves as legacy non-thinking
  const defaultViolation = checkGeminiWebUnsupportedControls({ reasoning_effort: "high" });
  assert.equal(defaultViolation?.param, "reasoning_effort");
});

test("gemini-deep-think allows omitted effort, high, max, and xhigh", () => {
  assert.equal(checkGeminiWebUnsupportedControls({}, "gemini-deep-think"), null);
  assert.equal(
    checkGeminiWebUnsupportedControls({ reasoning_effort: null }, "gemini-deep-think"),
    null
  );
  assert.equal(
    checkGeminiWebUnsupportedControls({ reasoning_effort: undefined }, "gemini-deep-think"),
    null
  );
  assert.equal(
    checkGeminiWebUnsupportedControls({ reasoning_effort: "high" }, "gemini-deep-think"),
    null
  );
  assert.equal(
    checkGeminiWebUnsupportedControls({ reasoning_effort: "max" }, "gemini-deep-think"),
    null
  );
  assert.equal(
    checkGeminiWebUnsupportedControls({ reasoning_effort: "xhigh" }, "gemini-deep-think"),
    null
  );
  assert.equal(
    checkGeminiWebUnsupportedControls({ reasoning_effort: "  HIGH  " }, "gemini-deep-think"),
    null
  );
});

test("gemini-deep-think rejects none, minimal, low, medium with 400 unsupported_control_for_provider", () => {
  assert.equal(GEMINI_WEB_UNSUPPORTED_CONTROL_CODE, "unsupported_control_for_provider");

  for (const effort of ["none", "minimal", "low", "medium"]) {
    const violation = checkGeminiWebUnsupportedControls(
      { reasoning_effort: effort },
      "gemini-deep-think"
    );
    assert.equal(
      violation?.param,
      "reasoning_effort",
      `gemini-deep-think must reject reasoning_effort="${effort}"`
    );
    assert.match(violation!.message, /gemini-deep-think/i);
  }
});

test("gemini-deep-think still enforces tool_choice guards", () => {
  const forcedViolation = checkGeminiWebUnsupportedControls(
    { tool_choice: "required" },
    "gemini-deep-think"
  );
  assert.equal(forcedViolation?.param, "tool_choice");

  const autoOk = checkGeminiWebUnsupportedControls({ tool_choice: "auto" }, "gemini-deep-think");
  assert.equal(autoOk, null);
});
