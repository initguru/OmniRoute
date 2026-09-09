import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Run the installed Google-signed language server against a synthetic local
// Cloud Code server. macOS sandbox-exec prevents accidental remote requests.
// This captures a real client's serialization, NOT a successful Google request.
const binary = process.argv[2];
const output = process.argv[3];
if (!binary || !output || process.platform !== "darwin") {
  throw new Error("Usage (macOS): node antigravity-reference-capture.mjs <binary> <output.json>");
}

const scratch = await mkdtemp(path.join(tmpdir(), "agy-reference-"));
const workspace = path.join(scratch, "workspace");
await mkdir(workspace);
const observations = [];
const rpcResults = [];
const logs = [];
const csrf = "synthetic-local-csrf";
const metadata = {
  ideName: "antigravity",
  ideVersion: "2.0.6",
  extensionVersion: "2.0.6",
  sessionId: "synthetic-capture-session",
  disableTelemetry: true,
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyUtf8 = Buffer.concat(chunks).toString("utf8");
  observations.push({
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    headers: Array.from({ length: req.rawHeaders.length / 2 }, (_, i) => {
      const name = req.rawHeaders[i * 2];
      return [
        name,
        /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)
          ? "[redacted]"
          : req.rawHeaders[i * 2 + 1],
      ];
    }),
    bodyUtf8,
  });
  if (req.url.includes("streamGenerateContent")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ACK"}]},"finishReason":"STOP"}]}}\n\n'
    );
    return;
  }
  let response = {};
  if (req.url.includes("loadCodeAssist")) {
    response = {
      cloudaicompanionProject: "synthetic-project",
      currentTier: { id: "standard-tier", name: "Standard" },
      allowedTiers: [{ id: "standard-tier", name: "Standard", isDefault: true }],
    };
  } else if (req.url.includes("fetchAvailableModels")) {
    response = {
      models: {
        "claude-sonnet-4-5": {
          displayName: "Claude Sonnet 4.5",
          model: "claude-sonnet-4-5",
          maxTokens: 16384,
          maxInputTokens: 200000,
        },
      },
    };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
// Discover a free RPC port separately; the socket is closed before LS binds it.
const portProbe = http.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const rpcPort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));

const args = [
  "--standalone",
  "--disable_telemetry",
  "--override_ide_name",
  "antigravity",
  "--override_ide_version",
  "2.0.6",
  "--override_user_agent_name",
  "antigravity",
  "--cloud_code_endpoint",
  endpoint,
  "--api_server_url",
  endpoint,
  "--inference_api_server_url",
  endpoint,
  "--gemini_dir",
  path.join(scratch, "gemini"),
  "--app_data_dir",
  "app",
  "--config_dir",
  "config",
  "--http_server_port",
  String(rpcPort),
  "--csrf_token",
  csrf,
];
const sandbox =
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(deny mach-lookup (global-name "com.apple.securityd"))';
const child = spawn("/usr/bin/sandbox-exec", ["-p", sandbox, binary, ...args], {
  cwd: workspace,
  env: {
    PATH: "/usr/bin:/bin",
    TMPDIR: scratch,
    LANG: "en_US.UTF-8",
    JETSKI_OAUTH_TOKEN: "synthetic-local-token",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.on("data", (chunk) => {
  if (logs.length < 200) logs.push(chunk.toString("utf8"));
});

async function rpc(method, body) {
  const response = await fetch(
    `http://127.0.0.1:${rpcPort}/exa.language_server_pb.LanguageServerService/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { text };
  }
  rpcResults.push({ method, status: response.status, result });
  return result;
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Language server exited: ${child.exitCode}`);
    try {
      await rpc("GetAuthStatus", {});
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!ready) throw new Error("Language server did not become ready");
  const cascade = await rpc("StartCascade", {
    metadata,
    requestedModel: 333,
    source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
    workspaceUris: [`file://${workspace}`],
  });
  if (cascade.cascadeId) {
    await rpc("SendUserCascadeMessage", {
      cascadeId: cascade.cascadeId,
      metadata,
      items: [{ text: "Reply with ACK. Do not use tools." }],
      cascadeConfig: { plannerConfig: { planModel: 333, google: {} } },
      blocking: true,
      propagateError: true,
    });
  }
  await delay(1000);
} catch (error) {
  rpcResults.push({ error: error.message });
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2000).then(() => child.kill("SIGKILL")),
  ]);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const artifact = {
    provenance: {
      kind: "official-client-synthetic-upstream",
      binary,
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      collectedAt: new Date().toISOString(),
      profile: "desktop-language-server-2.0.6-standalone-darwin-arm64",
      upstream: "loopback-only; Google acceptance and TLS not measured",
    },
    observations,
    rpcResults,
    // Do not persist authentication diagnostics from a real official login.
    logs: logs
      .join("")
      .split("\n")
      .filter((line) => !/token|oauth|auth|keyring|bearer|@/i.test(line))
      .join("\n"),
  };
  await writeFile(output, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 });
  await rm(scratch, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      output,
      requests: observations.map((entry) => ({ method: entry.method, path: entry.url })),
      rpc: rpcResults.map((entry) => ({
        method: entry.method,
        status: entry.status,
        error: entry.error,
      })),
    })
  );
}
