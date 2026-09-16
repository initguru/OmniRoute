import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  APPROVED_UNIVERSAL_PREFIX,
  APPROVED_UNIVERSAL_SUFFIX,
  APPROVED_UNIVERSAL_PREFIX_SHA256,
} from "../fixtures/systemPromptApprovedFixture.ts";

const {
  injectSystemPromptPostTranslation,
  injectSystemPromptPreTranslation,
  setSystemPromptConfig,
} = await import("../../open-sse/services/systemPrompt.ts");

test.after(() => {
  setSystemPromptConfig({ enabled: false, prefixPrompt: "", suffixPrompt: "" });
});

test("Universal prefix fixture exact metrics and checksum", () => {
  assert.equal(
    APPROVED_UNIVERSAL_PREFIX.length,
    1287,
    "Prefix character length must be exactly 1287"
  );
  const words = APPROVED_UNIVERSAL_PREFIX.trim().split(/\s+/).filter(Boolean);
  assert.equal(words.length, 175, "Prefix word count must be exactly 175");
  const hash = crypto.createHash("sha256").update(APPROVED_UNIVERSAL_PREFIX).digest("hex");
  assert.equal(hash, APPROVED_UNIVERSAL_PREFIX_SHA256, "Prefix SHA256 checksum mismatch");
  assert.equal(APPROVED_UNIVERSAL_SUFFIX, "", "Universal suffix must be empty string");
});

test("Carrier-ful Seam (Claude): prefix prepends without trailing delimiter when suffix is empty", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const body = {
    system: "Client system instructions",
    messages: [{ role: "user", content: "Hello" }],
  };

  const injected = injectSystemPromptPostTranslation(body, { targetFormat: "claude" });
  assert.ok(injected.system.startsWith(APPROVED_UNIVERSAL_PREFIX));
  assert.ok(injected.system.includes("Client system instructions"));
  assert.equal(injected.system, `${APPROVED_UNIVERSAL_PREFIX}\n\nClient system instructions`);
});

test("Carrier-ful Seam (Gemini): prefix prepends to systemInstruction parts without trailing delimiter", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const body = {
    systemInstruction: {
      role: "system",
      parts: [{ text: "Existing gemini system" }],
    },
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  };

  const injected = injectSystemPromptPostTranslation(body, { targetFormat: "gemini" });
  assert.equal(injected.systemInstruction.parts.length, 2);
  assert.equal(injected.systemInstruction.parts[0].text, APPROVED_UNIVERSAL_PREFIX);
  assert.equal(injected.systemInstruction.parts[1].text, "Existing gemini system");
});

test("Carrier-ful Seam (OpenAI Responses): prefix prepends to instructions", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const body = {
    instructions: "Base response instructions",
    input: [{ role: "user", content: "Hello" }],
  };

  const injected = injectSystemPromptPostTranslation(body, { targetFormat: "openai-responses" });
  assert.equal(injected.instructions, `${APPROVED_UNIVERSAL_PREFIX}\n\nBase response instructions`);
});

test("Carrier-ful Seam (OpenAI / Codex): prefix prepends to first system/developer message", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const body = {
    messages: [
      { role: "developer", content: "Developer instruction 0" },
      { role: "developer", content: "Developer instruction 1" },
      { role: "user", content: "Hello" },
    ],
  };

  const injected = injectSystemPromptPostTranslation(body, { targetFormat: "openai" });
  assert.ok(injected.messages[0].content.startsWith(APPROVED_UNIVERSAL_PREFIX));
  assert.ok(injected.messages[0].content.includes("Developer instruction 0"));
  // Middle/last developer untouched when suffix is empty
  assert.equal(injected.messages[1].content, "Developer instruction 1");
});

test("Carrier-less Seam (Kiro): injects once pre-translation, post-translation is a strict no-op", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const preBody = {
    messages: [
      { role: "system", content: "Original system" },
      { role: "user", content: "Solve issue" },
    ],
  };

  // Pre-translation injection
  const preInjected = injectSystemPromptPreTranslation(preBody, { targetFormat: "kiro" });
  assert.ok(preInjected.messages[0].content.startsWith(APPROVED_UNIVERSAL_PREFIX));
  assert.ok(preInjected.messages[0].content.includes("Original system"));
  assert.equal(preInjected._systemPromptInjected, true);

  // Subsequent post-translation must be strict no-op
  const postInjected = injectSystemPromptPostTranslation(preInjected, { targetFormat: "kiro" });
  assert.deepEqual(postInjected, preInjected);
});

test("Carrier-less Seam (Antigravity): injects once pre-translation, post-translation is a strict no-op", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const preBody = {
    messages: [
      { role: "system", content: "Antigravity system prompt" },
      { role: "user", content: "Execute task" },
    ],
  };

  // Pre-translation injection
  const preInjected = injectSystemPromptPreTranslation(preBody, { targetFormat: "antigravity" });
  assert.ok(preInjected.messages[0].content.startsWith(APPROVED_UNIVERSAL_PREFIX));
  assert.ok(preInjected.messages[0].content.includes("Antigravity system prompt"));
  assert.equal(preInjected._systemPromptInjected, true);

  // Subsequent post-translation must be strict no-op
  const postInjected = injectSystemPromptPostTranslation(preInjected, {
    targetFormat: "antigravity",
  });
  assert.deepEqual(postInjected, preInjected);
});

test("Bypass Seam: Gemini Deep Think completely bypasses both pre- and post-translation injection", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const body = {
    messages: [
      { role: "system", content: "Deep Think Original" },
      { role: "user", content: "Complex reason" },
    ],
  };

  const preBypassed = injectSystemPromptPreTranslation(body, {
    targetFormat: "antigravity",
    provider: "gemini-web",
    model: "gemini-deep-think",
  });
  assert.deepEqual(preBypassed, body);

  const postBypassed = injectSystemPromptPostTranslation(body, {
    targetFormat: "openai",
    provider: "gemini-web",
    model: "gemini-web/gemini-deep-think",
  });
  assert.deepEqual(postBypassed, body);
});

test("Single-Injection Idempotency: second pass returns immediately via _systemPromptInjected", () => {
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: APPROVED_UNIVERSAL_PREFIX,
    suffixPrompt: "",
  });

  const body = {
    messages: [
      { role: "system", content: "Base system" },
      { role: "user", content: "Hello" },
    ],
  };

  const firstPass = injectSystemPromptPostTranslation(body, { targetFormat: "openai" });
  assert.equal(firstPass._systemPromptInjected, true);

  const secondPass = injectSystemPromptPostTranslation(firstPass, { targetFormat: "openai" });
  assert.deepEqual(secondPass, firstPass);
  // Ensure prefix was not prepended twice
  const prefixOccurrences = (
    secondPass.messages[0].content.match(/Distinguish direct evidence/g) || []
  ).length;
  assert.equal(prefixOccurrences, 1);
});

test("Deterministic Behavioral Smoke Suite: verification of evidentiary instructions", () => {
  // Non-coding factual query fixture: verifies prompt maintains concise evidentiary focus
  assert.ok(
    APPROVED_UNIVERSAL_PREFIX.includes(
      "Distinguish direct evidence from inference, hypothesis, and assumption; plausibility is not proof."
    ),
    "Evidentiary distinction missing"
  );
  assert.ok(
    APPROVED_UNIVERSAL_PREFIX.includes(
      "Preserve unknown or unverified status. Absence of errors is not evidence of success."
    ),
    "Unverified preservation missing"
  );

  // Trivial coding query fixture: verifies no speculative elaboration
  assert.ok(
    APPROVED_UNIVERSAL_PREFIX.includes("Return only the evidence needed for the current decision."),
    "Bounded context evidence missing"
  );

  // Evidence-seeking inquiry fixture: verifies tool-first verification instructions
  assert.ok(
    APPROVED_UNIVERSAL_PREFIX.includes(
      "Before making factual or operational claims that depend on current or local state, use available tools and live sources when authorized and proportionate."
    ),
    "Tool-first verification instruction missing"
  );
  assert.ok(
    APPROVED_UNIVERSAL_PREFIX.includes(
      "In the final response, state what changed, what was verified, and what remains unverified."
    ),
    "Reporting contract instruction missing"
  );
});
