import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { assertRedactedAntigravityArtifact } from "../../tests/helpers/antigravityWireContract.ts";

const execFileAsync = promisify(execFile);

export const CANARY_ISSUE_LABELS = {
  BASE: "antigravity-canary",
  PROFILE_CLI: "antigravity-canary-cli",
  PROFILE_IDE: "antigravity-canary-ide",
  STATUS_DRIFT: "antigravity-canary-drift",
  STATUS_BLOCKED: "antigravity-canary-blocked",
};

/**
 * Returns the living canary issue title for the given profile.
 *
 * @param {"cli" | "ide"} profile
 * @returns {string}
 */
export function getCanaryIssueTitle(profile) {
  const norm = String(profile).toLowerCase();
  return `[Antigravity canary][${norm}] external parity`;
}

/**
 * Returns the expected label set for a profile and outcome.
 *
 * @param {"cli" | "ide"} profile
 * @param {"drift" | "blocked" | "pass"} outcome
 * @returns {string[]}
 */
export function getCanaryIssueLabels(profile, outcome) {
  const normProfile = String(profile).toLowerCase();
  const profileLabel = `antigravity-canary-${normProfile}`;
  const labels = [CANARY_ISSUE_LABELS.BASE, profileLabel];

  const normOutcome = String(outcome).toLowerCase();
  if (normOutcome === "drift") {
    labels.push(CANARY_ISSUE_LABELS.STATUS_DRIFT);
  } else if (normOutcome === "blocked") {
    labels.push(CANARY_ISSUE_LABELS.STATUS_BLOCKED);
  }

  return labels;
}

/**
 * Default GitHub CLI runner executing arguments directly via child_process.execFile.
 * Adheres strictly to Hard Rule #13 (no shell interpolation).
 *
 * @param {string[]} args
 * @returns {Promise<{ stdout: string; stderr: string }>}
 */
export async function defaultGhRunner(args) {
  return execFileAsync("gh", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function assertNoRawSecretsInText(text) {
  if (typeof text !== "string" || !text) return;

  // Raw bearer tokens
  const bearerMatch =
    /Bearer\s+(?!\[redacted\]|\[masked\]|<redacted>|<masked>)[a-zA-Z0-9_\-\.]{10,}/i.exec(text);
  if (bearerMatch) {
    throw new Error(
      `Antigravity canary issue text contains unredacted Bearer token: ${bearerMatch[0].slice(0, 15)}...`
    );
  }

  // Raw credential / token key-value patterns
  const kvMatch =
    /(?:api[-_]?key|auth[-_]?token|refresh[-_]?token|project[-_]?secret)\s*[:=]\s*["']?(?!\[redacted\]|\[masked\]|<redacted>|<masked>)[a-zA-Z0-9_\-\.]{6,}["']?/i.exec(
      text
    );
  if (kvMatch) {
    throw new Error(`Antigravity canary issue text contains unredacted credential: ${kvMatch[0]}`);
  }
}

function assertCanaryRedaction({
  profile,
  outcome,
  reasonCode,
  details,
  reportPath,
  body,
  comment,
}) {
  if (reportPath && fs.existsSync(reportPath)) {
    const raw = fs.readFileSync(reportPath, "utf8");
    const parsed = JSON.parse(raw);
    assertRedactedAntigravityArtifact(parsed);
  }

  if (details && typeof details === "object") {
    assertRedactedAntigravityArtifact(details);
  } else if (typeof details === "string") {
    try {
      const parsed = JSON.parse(details);
      if (parsed && typeof parsed === "object") {
        assertRedactedAntigravityArtifact(parsed);
      }
    } catch {
      // Plain string details
    }
  }

  // Construct artifact verification container to catch raw sensitive field names
  assertRedactedAntigravityArtifact({
    profile,
    outcome,
    reasonCode: reasonCode || "none",
    ...(details && typeof details === "object" ? details : {}),
  });

  assertNoRawSecretsInText(`${body || ""} ${comment || ""}`);
}

function buildIssueBody({ profile, outcome, reasonCode, details, reportPath }) {
  const timestamp = new Date().toISOString();
  let detailsText = "";
  if (details) {
    if (typeof details === "object") {
      detailsText = "```json\n" + JSON.stringify(details, null, 2) + "\n```";
    } else {
      detailsText = String(details);
    }
  }

  return [
    `# Antigravity Canary Alert: ${outcome.toUpperCase()} (${profile})`,
    "",
    "| Property | Value |",
    "| --- | --- |",
    `| **Profile** | \`${profile}\` |`,
    `| **Outcome** | \`${outcome}\` |`,
    `| **Reason Code** | \`${reasonCode || "n/a"}\` |`,
    `| **Updated At** | \`${timestamp}\` |`,
    reportPath ? `| **Report Artifact** | \`${reportPath}\` |` : "",
    "",
    "## Summary Details",
    detailsText || "No additional details provided.",
    "",
    "---",
    "_Automated living issue managed by Antigravity canary defense pipeline._",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildIssueComment({ outcome, reasonCode, details }) {
  const timestamp = new Date().toISOString();
  let detailsText = "";
  if (details) {
    if (typeof details === "object") {
      detailsText = "```json\n" + JSON.stringify(details, null, 2) + "\n```";
    } else {
      detailsText = String(details);
    }
  }

  if (outcome === "pass") {
    return [
      `### Canary Run: PASS (${timestamp})`,
      "External wire parity verified successfully. Closing issue as completed.",
    ].join("\n");
  }

  return [
    `### Canary Run: ${outcome.toUpperCase()} (${timestamp})`,
    `- **Reason Code**: \`${reasonCode || "n/a"}\``,
    detailsText ? `\n<details><summary>Run Details</summary>\n\n${detailsText}\n</details>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseIssueNumberFromOutput(result) {
  const text = typeof result === "string" ? result : (result?.stdout ?? "");
  const match = text.match(/\/issues\/(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  const numericMatch = text.match(/^(\d+)$/m);
  if (numericMatch) {
    return parseInt(numericMatch[1], 10);
  }
  return null;
}

/**
 * @typedef {Object} CanaryIssueOptions
 * @property {string} repo - Target repository (e.g. "diegosouzapw/OmniRoute")
 * @property {"cli" | "ide"} profile - Client profile
 * @property {"drift" | "blocked" | "pass"} outcome - Canary execution outcome
 * @property {string} [reasonCode] - Machine-readable reason code
 * @property {any} [details] - Descriptive details or structured differences
 * @property {string} [reportPath] - Path to redacted report artifact JSON
 * @property {Function} [runner] - gh runner function (defaults to defaultGhRunner)
 */

/**
 * Synchronizes external canary run result into a living GitHub issue atomically per profile.
 *
 * @param {CanaryIssueOptions} options
 */
export async function updateAntigravityCanaryIssue(options) {
  const {
    repo = process.env.GITHUB_REPOSITORY || "diegosouzapw/OmniRoute",
    profile,
    outcome,
    reasonCode,
    details,
    reportPath,
    runner = defaultGhRunner,
  } = options;

  if (!profile || (profile !== "cli" && profile !== "ide")) {
    throw new Error(`Invalid or missing profile: "${profile}". Expected "cli" or "ide".`);
  }

  const normOutcome = String(outcome).toLowerCase();
  if (normOutcome !== "drift" && normOutcome !== "blocked" && normOutcome !== "pass") {
    throw new Error(
      `Invalid or missing outcome: "${outcome}". Expected "drift", "blocked", or "pass".`
    );
  }

  const expectedTitle = getCanaryIssueTitle(profile);
  const expectedProfileLabel = `antigravity-canary-${profile.toLowerCase()}`;
  const statusLabel =
    normOutcome === "drift"
      ? CANARY_ISSUE_LABELS.STATUS_DRIFT
      : normOutcome === "blocked"
        ? CANARY_ISSUE_LABELS.STATUS_BLOCKED
        : null;
  const oppositeStatusLabel =
    normOutcome === "drift"
      ? CANARY_ISSUE_LABELS.STATUS_BLOCKED
      : normOutcome === "blocked"
        ? CANARY_ISSUE_LABELS.STATUS_DRIFT
        : null;

  // Redaction assertion prior to any GitHub operation
  assertCanaryRedaction({
    profile,
    outcome: normOutcome,
    reasonCode,
    details,
    reportPath,
  });

  // Query existing candidates
  // Duplicate prevention safeguard: errors are NOT caught, so failures propagate immediately
  const listResult = await runner([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--json",
    "number,title,state,labels",
  ]);

  const listStdout = typeof listResult === "string" ? listResult : (listResult?.stdout ?? "[]");
  const issues = JSON.parse(listStdout || "[]");

  const matchingIssues = issues.filter((issue) => {
    if (issue.title !== expectedTitle) return false;
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    return labels.includes(expectedProfileLabel);
  });

  const existingIssue = matchingIssues[0] || null;
  const existingState = (existingIssue?.state || "").toUpperCase();

  // Status transition: pass
  if (normOutcome === "pass") {
    if (!existingIssue || existingState === "CLOSED") {
      return {
        action: "noop",
        issueNumber: null,
        title: expectedTitle,
        outcome: normOutcome,
        message: "No open issue to close for passing canary run.",
      };
    }

    const commentBody = buildIssueComment({ outcome: normOutcome, reasonCode, details });
    assertCanaryRedaction({
      profile,
      outcome: normOutcome,
      reasonCode,
      details,
      reportPath,
      comment: commentBody,
    });

    await runner([
      "issue",
      "comment",
      String(existingIssue.number),
      "--repo",
      repo,
      "--body",
      commentBody,
    ]);

    await runner([
      "issue",
      "close",
      String(existingIssue.number),
      "--repo",
      repo,
      "--reason",
      "completed",
    ]);

    return {
      action: "closed",
      issueNumber: existingIssue.number,
      title: expectedTitle,
      outcome: normOutcome,
    };
  }

  // Status transition: drift or blocked
  const body = buildIssueBody({ profile, outcome: normOutcome, reasonCode, details, reportPath });
  const commentBody = buildIssueComment({ outcome: normOutcome, reasonCode, details });

  assertCanaryRedaction({
    profile,
    outcome: normOutcome,
    reasonCode,
    details,
    reportPath,
    body,
    comment: commentBody,
  });

  // If no existing issue: create new issue
  if (!existingIssue) {
    const createArgs = [
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      expectedTitle,
      "--body",
      body,
      "--label",
      CANARY_ISSUE_LABELS.BASE,
      "--label",
      expectedProfileLabel,
      "--label",
      statusLabel,
    ];

    const createResult = await runner(createArgs);
    const createdNumber = parseIssueNumberFromOutput(createResult);

    return {
      action: "created",
      issueNumber: createdNumber,
      title: expectedTitle,
      outcome: normOutcome,
    };
  }

  // Existing issue found
  const isClosed = existingState === "CLOSED";
  if (isClosed) {
    await runner(["issue", "reopen", String(existingIssue.number), "--repo", repo]);
  }

  const existingLabels = (existingIssue.labels || []).map((l) =>
    typeof l === "string" ? l : l.name
  );

  const editArgs = ["issue", "edit", String(existingIssue.number), "--repo", repo, "--body", body];

  // Remove previous status label if switching drift <-> blocked
  if (oppositeStatusLabel && existingLabels.includes(oppositeStatusLabel)) {
    editArgs.push("--remove-label", oppositeStatusLabel);
  }

  // Ensure current status label is added
  editArgs.push("--add-label", statusLabel);

  await runner(editArgs);

  await runner([
    "issue",
    "comment",
    String(existingIssue.number),
    "--repo",
    repo,
    "--body",
    commentBody,
  ]);

  return {
    action: isClosed ? "reopened" : "updated",
    issueNumber: existingIssue.number,
    title: expectedTitle,
    outcome: normOutcome,
  };
}

function printUsage() {
  console.log(
    "Usage: node scripts/check/update-antigravity-canary-issue.mjs --profile <cli|ide> --outcome <drift|blocked|pass> [options]"
  );
  console.log("Options:");
  console.log("  --repo <owner/repo>          Target repository (default: $GITHUB_REPOSITORY)");
  console.log("  --profile <cli|ide>          Client profile (required)");
  console.log("  --outcome <drift|blocked|pass> Canary outcome (required)");
  console.log("  --reason <reasonCode>        Machine readable reason code");
  console.log("  --details <details>          Summary or JSON details");
  console.log("  --report <reportPath>        Path to report artifact JSON file");
}

function parseCliArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo" && i + 1 < argv.length) {
      parsed.repo = argv[++i];
    } else if (arg === "--profile" && i + 1 < argv.length) {
      parsed.profile = argv[++i];
    } else if (arg === "--outcome" && i + 1 < argv.length) {
      parsed.outcome = argv[++i];
    } else if (arg === "--reason" && i + 1 < argv.length) {
      parsed.reasonCode = argv[++i];
    } else if (arg === "--details" && i + 1 < argv.length) {
      parsed.details = argv[++i];
    } else if (arg === "--report" && i + 1 < argv.length) {
      parsed.reportPath = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }
  return parsed;
}

if (process.argv[1] && process.argv[1].endsWith("update-antigravity-canary-issue.mjs")) {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (!cliArgs.profile || !cliArgs.outcome) {
    printUsage();
    process.exit(1);
  }

  updateAntigravityCanaryIssue(cliArgs)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Failed to update canary issue:", err);
      process.exit(1);
    });
}
