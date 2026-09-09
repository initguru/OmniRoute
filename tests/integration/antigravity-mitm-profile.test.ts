import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { AntigravityHandler } from "../../src/mitm/handlers/antigravity.ts";

const require = createRequire(import.meta.url);
const { ANTIGRAVITY_PATH, CHAT_PATH, resolveForwardTarget } =
  require("../../src/mitm/_internal/forwardTarget.cjs") as {
    ANTIGRAVITY_PATH: string;
    CHAT_PATH: string;
    resolveForwardTarget: (
      baseUrl: string,
      body: unknown
    ) => {
      url: string;
      format: "antigravity" | "openai";
    };
  };

type CapturedRequest = {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startLocalReceiver(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        path: req.url || "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: local-receiver\\n\\n");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("local receiver did not expose a TCP address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

function fakeResponse(): {
  response: Parameters<AntigravityHandler["intercept"]>[1];
  chunks: string[];
} {
  const chunks: string[] = [];
  let headersSent = false;
  const response = {
    get headersSent() {
      return headersSent;
    },
    writeHead() {
      headersSent = true;
    },
    write(chunk: Buffer | string) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    },
  } as unknown as Parameters<AntigravityHandler["intercept"]>[1];
  return { response, chunks };
}

test("MITM profile boundary keeps identity with the router receiver", async (t) => {
  const receiver = await startLocalReceiver();
  t.after(() => receiver.close());

  const previousBaseUrl = process.env.OMNIROUTE_BASE_URL;
  process.env.OMNIROUTE_BASE_URL = receiver.baseUrl;
  t.after(() => {
    if (previousBaseUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
    else process.env.OMNIROUTE_BASE_URL = previousBaseUrl;
  });

  const { response, chunks } = fakeResponse();
  const req = {
    method: "POST",
    url: "/v1internal:streamGenerateContent",
    headers: {
      host: "cloudcode-pa.googleapis.com",
      "user-agent": "forged-cli/99.0",
      "x-client-profile": "cli",
      clientprofile: "cli",
      "x-omniroute-agent": "cli",
      "x-omniroute-source": "omniroute",
      "X-OmniRoute-Connection": "forced-connection",
    },
  } as unknown as Parameters<AntigravityHandler["intercept"]>[0];

  await new AntigravityHandler().intercept(
    req,
    response,
    Buffer.from(
      JSON.stringify({
        clientProfile: "cli",
        userAgent: "forged-cli/99.0",
        request: {
          clientProfile: "cli",
          contents: [{ role: "user", parts: [{ text: "local profile probe" }] }],
        },
      })
    ),
    "ag-claude-opus-4-6-thinking"
  );

  assert.equal(chunks.join(""), "data: local-receiver\\n\\n");
  assert.equal(receiver.requests.length, 1);
  const captured = receiver.requests[0];
  assert.equal(new URL(receiver.baseUrl).hostname, "127.0.0.1");
  assert.equal(captured.path, CHAT_PATH);
  assert.equal(captured.headers["x-omniroute-source"], "agent-bridge");
  assert.equal(captured.headers["x-omniroute-agent"], "antigravity");
  assert.equal(captured.headers["x-omniroute-connection"], undefined);
  assert.notEqual(captured.headers["user-agent"], "forged-cli/99.0");
  assert.equal(captured.headers["x-client-profile"], undefined);
  assert.equal(captured.headers.clientprofile, undefined);

  const body = JSON.parse(captured.body) as Record<string, unknown>;
  assert.equal(body.clientProfile, undefined);
  assert.equal(body.userAgent, undefined);
  assert.equal(body.request, undefined);
  assert.deepEqual(body.messages, [{ role: "user", content: "local profile probe" }]);
});

test("standalone MITM source loop keeps passthrough separate from handler provenance", () => {
  const source = readFileSync(new URL("../../src/mitm/server.cjs", import.meta.url), "utf8");
  assert.match(source, /req\.headers\["x-omniroute-source"\]\s*===\s*"omniroute"/);
  assert.match(source, /return passthrough\(req, res, bodyBuffer\)/);
});

test("MITM route split remains format-driven and identity-independent", () => {
  const cloudcode = resolveForwardTarget("http://127.0.0.1:20128", {
    clientProfile: "cli",
    request: { contents: [] },
  });
  const openai = resolveForwardTarget("http://127.0.0.1:20128", {
    clientProfile: "cli",
    messages: [],
  });

  assert.equal(cloudcode.url, `http://127.0.0.1:20128${ANTIGRAVITY_PATH}`);
  assert.equal(cloudcode.format, "antigravity");
  assert.equal(openai.url, `http://127.0.0.1:20128${CHAT_PATH}`);
  assert.equal(openai.format, "openai");
});
