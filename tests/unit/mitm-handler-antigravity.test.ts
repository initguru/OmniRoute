import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AntigravityHandler, convertGeminiToOpenAI } from "../../src/mitm/handlers/antigravity.ts";
import { runHandler } from "./_mitmHandlerHarness.ts";

async function runHandlerWithUpstreamChunks(
  chunks: Buffer[],
  body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: "chunked" }] }],
  }
): Promise<Buffer[]> {
  const originalFetch = globalThis.fetch;
  const responseChunks: Buffer[] = [];
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    writeHead() {
      headersSent = true;
    },
    write(chunk: Buffer | string) {
      responseChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk)
        responseChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  const request = {
    method: "POST",
    url: "/v1internal:streamGenerateContent",
    headers: { host: "api.example.com" },
  } as unknown as IncomingMessage;
  const stream = Readable.toWeb(Readable.from(chunks)) as unknown as ReadableStream<Uint8Array>;
  globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;

  try {
    await new AntigravityHandler().intercept(
      request,
      response,
      Buffer.from(JSON.stringify(body)),
      "ag-claude-opus-4-6-thinking"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return responseChunks;
}

test("antigravity handler — forwards to OmniRoute and pipes SSE", async () => {
  const r = await runHandler(
    new AntigravityHandler(),
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    "claude-3.5-sonnet",
    { upstreamBody: "data: hello\n\ndata: world\n\n" }
  );
  assert.ok(r.fetchCalled);
  assert.equal(r.status, 200);
  assert.ok(r.responseChunks.join("").includes("hello"));
});

test("antigravity handler — propagates upstream failure as 500", async () => {
  const r = await runHandler(new AntigravityHandler(), { model: "gpt-4o" }, "claude-3.5-sonnet", {
    upstreamStatus: 500,
    upstreamBody: "boom",
  });
  assert.equal(r.status, 500);
  const body = r.responseChunks.join("");
  // Error must NOT include raw stack trace (Hard Rule #12 sanitization).
  assert.ok(!body.includes("at /"));
});

test("convertGeminiToOpenAI — maps Gemini fields to OpenAI chat body", () => {
  const out = convertGeminiToOpenAI(
    {
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi there" }] },
      ],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.4,
        topP: 0.9,
        stopSequences: ["STOP"],
      },
      // Gemini-only field that must NOT leak into the OpenAI body.
      thinkingConfig: { thinkingBudget: 1024 },
    } as Record<string, unknown>,
    "claude-opus-4-6-thinking",
    true
  );

  assert.equal(out.model, "claude-opus-4-6-thinking");
  assert.equal(out.stream, true);
  assert.deepEqual(out.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.equal(out.max_tokens, 256);
  assert.equal(out.temperature, 0.4);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop, ["STOP"]);
  // Gemini-native fields must be stripped, not forwarded.
  assert.equal((out as Record<string, unknown>).contents, undefined);
  assert.equal((out as Record<string, unknown>).generationConfig, undefined);
  assert.equal((out as Record<string, unknown>).thinkingConfig, undefined);
});

test("antigravity handler — converts raw Gemini body before forwarding", async () => {
  const r = await runHandler(
    new AntigravityHandler(),
    {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 64 },
      thinkingConfig: { thinkingBudget: 512 },
    },
    "ag-claude-opus-4-6-thinking",
    {
      upstreamBody: "data: pong\n\n",
      url: "/v1beta/models/gemini:streamGenerateContent",
    }
  );

  assert.ok(r.fetchCalled);
  const forwarded = JSON.parse(r.fetchBody);
  // The router must receive OpenAI format, not the raw Gemini body.
  assert.equal(forwarded.model, "ag-claude-opus-4-6-thinking");
  assert.equal(forwarded.stream, true);
  assert.deepEqual(forwarded.messages, [{ role: "user", content: "ping" }]);
  assert.equal(forwarded.max_tokens, 64);
  // Gemini-native fields that caused upstream 400s must be gone.
  assert.equal(forwarded.contents, undefined);
  assert.equal(forwarded.generationConfig, undefined);
  assert.equal(forwarded.thinkingConfig, undefined);
});

test("convertGeminiToOpenAI — unwraps the cloudcode-pa `.request` envelope (#4294)", () => {
  // Shape the real Antigravity IDE sends to cloudcode-pa /v1internal:generateContent.
  const out = convertGeminiToOpenAI(
    {
      project: "projects/123",
      model: "gemini-3-pro",
      userAgent: "Antigravity",
      requestType: "GENERATE",
      request: {
        systemInstruction: { parts: [{ text: "be brief" }] },
        contents: [
          { role: "user", parts: [{ text: "hello" }] },
          { role: "model", parts: [{ text: "hi there" }] },
        ],
        generationConfig: { maxOutputTokens: 256, temperature: 0.4 },
      },
    } as Record<string, unknown>,
    "ag-claude-opus-4-6-thinking",
    true
  );

  assert.equal(out.model, "ag-claude-opus-4-6-thinking");
  // Without the unwrap these would be empty → upstream gets an empty conversation → hang.
  assert.deepEqual(out.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.equal(out.max_tokens, 256);
  assert.equal(out.temperature, 0.4);
});

test("antigravity handler — forwards a cloudcode envelope request with real messages (#4294)", async () => {
  const r = await runHandler(
    new AntigravityHandler(),
    {
      project: "projects/123",
      model: "gemini-3-pro",
      request: {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 64 },
      },
    },
    "ag-claude-opus-4-6-thinking",
    {
      upstreamBody: "data: pong\n\n",
      url: "/v1internal:streamGenerateContent",
    }
  );

  assert.ok(r.fetchCalled);
  const forwarded = JSON.parse(r.fetchBody);
  assert.equal(forwarded.model, "ag-claude-opus-4-6-thinking");
  assert.equal(forwarded.stream, true);
  // The prompt must survive the conversion (the hang was an empty messages array).
  assert.deepEqual(forwarded.messages, [{ role: "user", content: "ping" }]);
  assert.equal(forwarded.max_tokens, 64);
  // Envelope wrapper fields must not leak into the OpenAI body.
  assert.equal(forwarded.request, undefined);
  assert.equal(forwarded.project, undefined);
});

test("antigravity handler — ignores inbound identity override headers", async () => {
  const r = await runHandler(
    new AntigravityHandler(),
    {
      clientProfile: "cli",
      userAgent: "forged-cli/99.0",
      request: {
        clientProfile: "cli",
        contents: [{ role: "user", parts: [{ text: "profile probe" }] }],
      },
    },
    "ag-claude-opus-4-6-thinking",
    {
      headers: {
        "User-Agent": "forged-cli/99.0",
        "x-client-profile": "cli",
        clientProfile: "cli",
        "x-omniroute-agent": "cli",
        "x-omniroute-source": "omniroute",
        "X-OmniRoute-Connection": "forced-connection",
      },
      upstreamBody: "data: profile-safe\\n\\n",
      url: "/v1internal:streamGenerateContent",
    }
  );

  assert.equal(r.fetchHeaders["user-agent"], undefined);
  assert.equal(r.fetchHeaders["x-client-profile"], undefined);
  assert.equal(r.fetchHeaders.clientprofile, undefined);
  assert.equal(r.fetchHeaders["x-omniroute-agent"], "antigravity");
  assert.equal(r.fetchHeaders["x-omniroute-source"], "agent-bridge");
  assert.equal(r.fetchHeaders["x-omniroute-connection"], undefined);
  const forwarded = JSON.parse(r.fetchBody);
  assert.equal(forwarded.clientProfile, undefined);
  assert.equal(forwarded.userAgent, undefined);
  assert.equal(forwarded.request, undefined);
});

test("antigravity handler — restores tool names in streamed responses", async () => {
  const r = await runHandler(
    new AntigravityHandler(),
    { contents: [{ role: "user", parts: [{ text: "run a command" }] }] },
    "ag-claude-opus-4-6-thinking",
    {
      upstreamBody:
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
      url: "/v1internal:streamGenerateContent",
    }
  );

  assert.match(r.responseChunks.join(""), /"name":"Bash"/);
  assert.doesNotMatch(r.responseChunks.join(""), /"name":"bash"/);
});

test("antigravity handler — restores tool names when marker spans response chunks", async () => {
  const chunks = await runHandlerWithUpstreamChunks([
    Buffer.from('data: {"name":"ba'),
    Buffer.from('sh"}\n\n'),
  ]);
  const output = Buffer.concat(chunks).toString();
  assert.match(output, /"name":"Bash"/);
  assert.doesNotMatch(output, /"name":"bash"/);
});

test("antigravity handler — preserves split UTF-8 bytes", async () => {
  const chunks = await runHandlerWithUpstreamChunks([Buffer.from([0xc3]), Buffer.from([0xa9])]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0xc3, 0xa9]));
});

test("antigravity handler — preserves arbitrary response bytes", async () => {
  const chunks = await runHandlerWithUpstreamChunks([Buffer.from([0x00, 0xff, 0x80])]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0x00, 0xff, 0x80]));
});

test("antigravity handler — restores tool names when marker prefix spans chunks", async () => {
  const chunks = await runHandlerWithUpstreamChunks([
    Buffer.from('data: {"na'),
    Buffer.from('me":"ba'),
    Buffer.from('sh"}\n\n'),
  ]);
  assert.match(Buffer.concat(chunks).toString(), /"name":"Bash"/);
});

test("antigravity handler — flushes oversized non-marker candidates", async () => {
  const oversized = Buffer.from(`data: {"${"x".repeat(512)}`);
  const chunks = await runHandlerWithUpstreamChunks([oversized, Buffer.from('"name":"bash"}')]);
  assert.deepEqual(
    Buffer.concat(chunks),
    Buffer.concat([oversized, Buffer.from('"name":"Bash"}')])
  );
});

test("antigravity handler — non-streaming URL yields stream:false", async () => {
  const r = await runHandler(
    new AntigravityHandler(),
    { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    "gpt-4o",
    { url: "/v1beta/models/gemini:generateContent" }
  );
  const forwarded = JSON.parse(r.fetchBody);
  assert.equal(forwarded.stream, false);
});
