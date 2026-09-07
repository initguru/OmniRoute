import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "../_setup/isolateDataDir.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

const schema = JSON.parse(
  readFileSync(
    new URL("../fixtures/antigravity-wire/prediction-service-schema.json", import.meta.url),
    "utf8"
  )
) as { fields: Array<{ name: string }> };

test("upstream envelope excludes client fields absent from the official protobuf", async () => {
  const source = {
    request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    userPromptId: "synthetic-prompt-1",
    metadata: { user_id: "claude-code-client" },
    service_tier: "auto",
    betas: ["client-only-beta"],
    unknownClientField: "must not reach Cloud Code",
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
  };
  const result = await new AntigravityExecutor().transformRequest(
    "claude-sonnet-4-5",
    source,
    true,
    { projectId: "synthetic-project" }
  );
  assert.ok(!(result instanceof Response));
  const allowedFields = new Set(schema.fields.map((field) => field.name));
  assert.deepEqual(
    Object.keys(result).filter((key) => !allowedFields.has(key)),
    []
  );
  assert.equal(result.userPromptId, "synthetic-prompt-1");
  assert.equal(
    result.enabledCreditTypes,
    undefined,
    "credits come from the configured billing path"
  );
  assert.equal(
    source.metadata.user_id,
    "claude-code-client",
    "translation must not mutate caller data"
  );
});

test("invalid optional prompt IDs never become invalid protobuf scalar values", async () => {
  for (const userPromptId of [123, {}, [], null]) {
    const result = await new AntigravityExecutor().transformRequest(
      "claude-sonnet-4-5",
      { request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] }, userPromptId },
      true,
      { projectId: "synthetic-project" }
    );
    assert.ok(!(result instanceof Response));
    assert.equal(result.userPromptId, undefined);
  }
});

test("tool name bookkeeping survives locally without becoming an upstream field", async () => {
  const toolNameMap = new Map([["safe_name", "original:name"]]);
  const result = await new AntigravityExecutor().transformRequest(
    "claude-sonnet-4-5",
    {
      request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      _toolNameMap: toolNameMap,
    },
    true,
    { projectId: "synthetic-project" }
  );
  assert.ok(!(result instanceof Response));
  assert.equal(result._toolNameMap, toolNameMap);
  assert.equal(JSON.stringify(result).includes("_toolNameMap"), false);
});
