import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAntigravityModelId,
  ANTIGRAVITY_PUBLIC_MODELS,
  ANTIGRAVITY_MODEL_ALIASES,
} from "../../open-sse/config/antigravityModelAliases.ts";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";

test("resolveAntigravityModelId maps Gemini 3.8 flash tiers to gemini-3.8-flash-tiered", () => {
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-medium"), "gemini-3.8-flash-tiered");
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-high"), "gemini-3.8-flash-tiered");
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-low"), "gemini-3.8-flash-tiered");
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash"), "gemini-3.8-flash-tiered");
  assert.equal(resolveAntigravityModelId("gemini-3.8-flash-tiered"), "gemini-3.8-flash-tiered");
});

test("resolveAntigravityModelId dynamically resolves future flash tiers with or without provider prefixes", () => {
  assert.equal(resolveAntigravityModelId("gemini-3.9-flash-low"), "gemini-3.9-flash-tiered");
  assert.equal(resolveAntigravityModelId("gemini-3.9-flash-medium"), "gemini-3.9-flash-tiered");
  assert.equal(resolveAntigravityModelId("gemini-3.9-flash-high"), "gemini-3.9-flash-tiered");
  assert.equal(resolveAntigravityModelId("agy/gemini-3.8-flash-medium"), "gemini-3.8-flash-tiered");
  assert.equal(resolveAntigravityModelId("antigravity/gemini-3.9-flash-high"), "gemini-3.9-flash-tiered");
  assert.equal(resolveAntigravityModelId("agy/gemini-4.0-flash-low"), "gemini-4.0-flash-tiered");
});

test("ANTIGRAVITY_PUBLIC_MODELS includes Gemini 3.8 flash tiers", () => {
  const modelIds = new Set(ANTIGRAVITY_PUBLIC_MODELS.map((m) => m.id));
  assert.ok(modelIds.has("gemini-3.8-flash-high"), "missing gemini-3.8-flash-high");
  assert.ok(modelIds.has("gemini-3.8-flash-medium"), "missing gemini-3.8-flash-medium");
  assert.ok(modelIds.has("gemini-3.8-flash-low"), "missing gemini-3.8-flash-low");
  assert.ok(modelIds.has("gemini-3.8-flash-tiered"), "missing gemini-3.8-flash-tiered");
});

test("ANTIGRAVITY_MODEL_ALIASES includes static Gemini 3.8 flash aliases", () => {
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["gemini-3.8-flash"], "gemini-3.8-flash-tiered");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["gemini-3.8-flash-high"], "gemini-3.8-flash-tiered");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["gemini-3.8-flash-medium"], "gemini-3.8-flash-tiered");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES["gemini-3.8-flash-low"], "gemini-3.8-flash-tiered");
});

test("MODEL_SPECS defines Gemini 3.8 flash family with proper thinking budgets", () => {
  const high = MODEL_SPECS["gemini-3.8-flash-high"];
  assert.ok(high, "gemini-3.8-flash-high spec should exist");
  assert.equal(high.defaultThinkingBudget, 24576);
  assert.equal(high.thinkingBudgetCap, 24576);
  assert.equal(high.supportsThinking, true);

  const medium = MODEL_SPECS["gemini-3.8-flash-medium"];
  assert.ok(medium, "gemini-3.8-flash-medium spec should exist");
  assert.equal(medium.defaultThinkingBudget, 8192);
  assert.equal(medium.thinkingBudgetCap, 24576);
  assert.equal(medium.supportsThinking, true);

  const low = MODEL_SPECS["gemini-3.8-flash-low"];
  assert.ok(low, "gemini-3.8-flash-low spec should exist");
  assert.equal(low.defaultThinkingBudget, 1024);
  assert.equal(low.thinkingBudgetCap, 24576);
  assert.equal(low.supportsThinking, true);

  const plain = MODEL_SPECS["gemini-3.8-flash"];
  assert.ok(plain, "gemini-3.8-flash spec should exist");
  assert.equal(plain.defaultThinkingBudget, 8192);
  assert.equal(plain.thinkingBudgetCap, 24576);
  assert.equal(plain.supportsThinking, true);

  const tiered = MODEL_SPECS["gemini-3.8-flash-tiered"];
  assert.ok(tiered, "gemini-3.8-flash-tiered spec should exist");
  assert.equal(tiered.defaultThinkingBudget, 8192);
  assert.equal(tiered.thinkingBudgetCap, 24576);
  assert.equal(tiered.supportsThinking, true);
});
