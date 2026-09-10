import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  updateAntigravityCanaryIssue,
  getCanaryIssueTitle,
  getCanaryIssueLabels,
} from "../../scripts/check/update-antigravity-canary-issue.mjs";

test("getCanaryIssueTitle returns exact title for cli and ide profiles", () => {
  assert.equal(getCanaryIssueTitle("cli"), "[Antigravity canary][cli] external parity");
  assert.equal(getCanaryIssueTitle("ide"), "[Antigravity canary][ide] external parity");
});

test("getCanaryIssueLabels returns expected labels for drift and blocked", () => {
  const cliDriftLabels = getCanaryIssueLabels("cli", "drift");
  assert.deepEqual(cliDriftLabels, [
    "antigravity-canary",
    "antigravity-canary-cli",
    "antigravity-canary-drift",
  ]);

  const ideBlockedLabels = getCanaryIssueLabels("ide", "blocked");
  assert.deepEqual(ideBlockedLabels, [
    "antigravity-canary",
    "antigravity-canary-ide",
    "antigravity-canary-blocked",
  ]);
});

test("updateAntigravityCanaryIssue propagates error when gh issue list fails (prevents duplicate issues)", async () => {
  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      throw new Error("GitHub API rate limit exceeded or network down");
    }
    return { stdout: "[]", stderr: "" };
  };

  await assert.rejects(async () => {
    await updateAntigravityCanaryIssue({
      repo: "diegosouzapw/OmniRoute",
      profile: "cli",
      outcome: "drift",
      reasonCode: "wire_mismatch",
      runner: mockRunner,
    });
  }, /GitHub API rate limit exceeded|network down/);

  // Verification: should NOT have proceeded to create issue
  assert.equal(recordedCalls.length, 1);
  assert.deepEqual(recordedCalls[0], [
    "issue",
    "list",
    "--repo",
    "diegosouzapw/OmniRoute",
    "--state",
    "all",
    "--json",
    "number,title,state,labels",
  ]);
});

test("updateAntigravityCanaryIssue creates new issue when none exists (drift)", async () => {
  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: "[]", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { stdout: "https://github.com/diegosouzapw/OmniRoute/issues/101\n", stderr: "" };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "drift",
    reasonCode: "wire_mismatch",
    details: "Detected unexpected header diff in request",
    runner: mockRunner,
  });

  assert.equal(res.action, "created");
  assert.equal(res.outcome, "drift");
  assert.equal(recordedCalls.length, 2);

  // 1. issue list
  assert.deepEqual(recordedCalls[0], [
    "issue",
    "list",
    "--repo",
    "diegosouzapw/OmniRoute",
    "--state",
    "all",
    "--json",
    "number,title,state,labels",
  ]);

  // 2. issue create
  const createArgs = recordedCalls[1];
  assert.equal(createArgs[0], "issue");
  assert.equal(createArgs[1], "create");
  assert.ok(createArgs.includes("--repo"));
  assert.ok(createArgs.includes("diegosouzapw/OmniRoute"));
  assert.ok(createArgs.includes("--title"));
  assert.ok(createArgs.includes("[Antigravity canary][cli] external parity"));
  assert.ok(createArgs.includes("--label"));
  assert.ok(createArgs.includes("antigravity-canary"));
  assert.ok(createArgs.includes("antigravity-canary-cli"));
  assert.ok(createArgs.includes("antigravity-canary-drift"));
});

test("updateAntigravityCanaryIssue creates new issue when none exists (blocked)", async () => {
  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: "[]", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { stdout: "https://github.com/diegosouzapw/OmniRoute/issues/102\n", stderr: "" };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "ide",
    outcome: "blocked",
    reasonCode: "binary_unapproved",
    details: "Local binary sha256 does not match signed approval",
    runner: mockRunner,
  });

  assert.equal(res.action, "created");
  assert.equal(res.outcome, "blocked");
  assert.equal(recordedCalls.length, 2);

  const createArgs = recordedCalls[1];
  assert.ok(createArgs.includes("[Antigravity canary][ide] external parity"));
  assert.ok(createArgs.includes("antigravity-canary-ide"));
  assert.ok(createArgs.includes("antigravity-canary-blocked"));
});

test("updateAntigravityCanaryIssue reopens, edits, and comments when existing issue is CLOSED", async () => {
  const existingIssue = {
    number: 42,
    title: "[Antigravity canary][cli] external parity",
    state: "CLOSED",
    labels: [
      { name: "antigravity-canary" },
      { name: "antigravity-canary-cli" },
      { name: "antigravity-canary-drift" },
    ],
  };

  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify([existingIssue]), stderr: "" };
    }
    if (
      args[0] === "issue" &&
      (args[1] === "reopen" || args[1] === "edit" || args[1] === "comment")
    ) {
      return { stdout: "ok\n", stderr: "" };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "drift",
    reasonCode: "wire_mismatch",
    details: "New drift detected in canary run",
    runner: mockRunner,
  });

  assert.equal(res.action, "reopened");
  assert.equal(res.issueNumber, 42);

  // Calls sequence: list, reopen, edit, comment
  assert.equal(recordedCalls.length, 4);

  // reopen
  assert.deepEqual(recordedCalls[1], ["issue", "reopen", "42", "--repo", "diegosouzapw/OmniRoute"]);

  // edit (updates body & labels)
  const editArgs = recordedCalls[2];
  assert.equal(editArgs[0], "issue");
  assert.equal(editArgs[1], "edit");
  assert.equal(editArgs[2], "42");
  assert.ok(editArgs.includes("--body"));
  assert.ok(editArgs.includes("--add-label"));
  assert.ok(editArgs.includes("antigravity-canary-drift"));

  // comment
  const commentArgs = recordedCalls[3];
  assert.equal(commentArgs[0], "issue");
  assert.equal(commentArgs[1], "comment");
  assert.equal(commentArgs[2], "42");
  assert.ok(commentArgs.includes("--body"));
});

test("updateAntigravityCanaryIssue edits and comments when existing issue is OPEN", async () => {
  const existingIssue = {
    number: 42,
    title: "[Antigravity canary][cli] external parity",
    state: "OPEN",
    labels: [
      { name: "antigravity-canary" },
      { name: "antigravity-canary-cli" },
      { name: "antigravity-canary-drift" },
    ],
  };

  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify([existingIssue]), stderr: "" };
    }
    if (args[0] === "issue" && (args[1] === "edit" || args[1] === "comment")) {
      return { stdout: "ok\n", stderr: "" };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "drift",
    reasonCode: "wire_mismatch",
    details: "Recurring drift in scheduled canary",
    runner: mockRunner,
  });

  assert.equal(res.action, "updated");
  assert.equal(res.issueNumber, 42);

  // Calls sequence: list, edit, comment (reopen is NOT called)
  assert.equal(recordedCalls.length, 3);
  assert.equal(recordedCalls[1][1], "edit");
  assert.equal(recordedCalls[2][1], "comment");
});

test("updateAntigravityCanaryIssue removes old status label and adds new status label on transition (drift -> blocked)", async () => {
  const existingIssue = {
    number: 42,
    title: "[Antigravity canary][cli] external parity",
    state: "OPEN",
    labels: [
      { name: "antigravity-canary" },
      { name: "antigravity-canary-cli" },
      { name: "antigravity-canary-drift" },
    ],
  };

  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify([existingIssue]), stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "blocked",
    reasonCode: "binary_signature_missing",
    details: "State changed from drift to blocked",
    runner: mockRunner,
  });

  assert.equal(res.action, "updated");

  // Verify edit command removed 'antigravity-canary-drift' and added 'antigravity-canary-blocked'
  const editArgs = recordedCalls[1];
  assert.equal(editArgs[1], "edit");

  const removeIndex = editArgs.indexOf("--remove-label");
  assert.ok(removeIndex !== -1, "Must have --remove-label");
  assert.ok(editArgs[removeIndex + 1].includes("antigravity-canary-drift"));

  const addIndex = editArgs.indexOf("--add-label");
  assert.ok(addIndex !== -1, "Must have --add-label");
  assert.ok(editArgs[addIndex + 1].includes("antigravity-canary-blocked"));
});

test("updateAntigravityCanaryIssue removes old status label and adds new status label on transition (blocked -> drift)", async () => {
  const existingIssue = {
    number: 42,
    title: "[Antigravity canary][ide] external parity",
    state: "OPEN",
    labels: [
      { name: "antigravity-canary" },
      { name: "antigravity-canary-ide" },
      { name: "antigravity-canary-blocked" },
    ],
  };

  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify([existingIssue]), stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "ide",
    outcome: "drift",
    reasonCode: "body_mismatch",
    details: "State changed from blocked to drift",
    runner: mockRunner,
  });

  assert.equal(res.action, "updated");

  const editArgs = recordedCalls[1];
  const removeIndex = editArgs.indexOf("--remove-label");
  assert.ok(removeIndex !== -1, "Must have --remove-label");
  assert.ok(editArgs[removeIndex + 1].includes("antigravity-canary-blocked"));

  const addIndex = editArgs.indexOf("--add-label");
  assert.ok(addIndex !== -1, "Must have --add-label");
  assert.ok(editArgs[addIndex + 1].includes("antigravity-canary-drift"));
});

test("updateAntigravityCanaryIssue closes open issue with pass comment on pass", async () => {
  const existingIssue = {
    number: 42,
    title: "[Antigravity canary][cli] external parity",
    state: "OPEN",
    labels: [
      { name: "antigravity-canary" },
      { name: "antigravity-canary-cli" },
      { name: "antigravity-canary-drift" },
    ],
  };

  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify([existingIssue]), stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "pass",
    runner: mockRunner,
  });

  assert.equal(res.action, "closed");
  assert.equal(res.issueNumber, 42);

  // Calls: list, comment, close
  assert.equal(recordedCalls.length, 3);

  // comment
  const commentArgs = recordedCalls[1];
  assert.equal(commentArgs[0], "issue");
  assert.equal(commentArgs[1], "comment");
  assert.equal(commentArgs[2], "42");
  assert.ok(commentArgs.includes("--body"));

  // close --reason completed
  const closeArgs = recordedCalls[2];
  assert.equal(closeArgs[0], "issue");
  assert.equal(closeArgs[1], "close");
  assert.equal(closeArgs[2], "42");
  assert.ok(closeArgs.includes("--reason"));
  assert.ok(closeArgs.includes("completed"));
});

test("updateAntigravityCanaryIssue is no-op on pass when no existing issue", async () => {
  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: "[]", stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "pass",
    runner: mockRunner,
  });

  assert.equal(res.action, "noop");
  assert.equal(res.issueNumber, null);
  // Only issue list was called
  assert.equal(recordedCalls.length, 1);
});

test("updateAntigravityCanaryIssue is no-op on pass when issue is already closed", async () => {
  const existingIssue = {
    number: 42,
    title: "[Antigravity canary][cli] external parity",
    state: "CLOSED",
    labels: [{ name: "antigravity-canary" }, { name: "antigravity-canary-cli" }],
  };

  const recordedCalls: string[][] = [];
  const mockRunner = async (args: string[]) => {
    recordedCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify([existingIssue]), stderr: "" };
    }
    return { stdout: "ok\n", stderr: "" };
  };

  const res = await updateAntigravityCanaryIssue({
    repo: "diegosouzapw/OmniRoute",
    profile: "cli",
    outcome: "pass",
    runner: mockRunner,
  });

  assert.equal(res.action, "noop");
  assert.equal(recordedCalls.length, 1);
});

test("updateAntigravityCanaryIssue fails redaction assertion on unredacted sensitive details (token)", async () => {
  let runnerCalled = false;
  const mockRunner = async () => {
    runnerCalled = true;
    return { stdout: "[]", stderr: "" };
  };

  await assert.rejects(async () => {
    await updateAntigravityCanaryIssue({
      repo: "diegosouzapw/OmniRoute",
      profile: "cli",
      outcome: "drift",
      details: { token: "raw-secret-token-12345" },
      runner: mockRunner,
    });
  }, /redact|sensitive/i);

  assert.equal(runnerCalled, false, "gh runner must not be called when redaction fails");
});

test("updateAntigravityCanaryIssue fails redaction assertion on unredacted sensitive details (project)", async () => {
  let runnerCalled = false;
  const mockRunner = async () => {
    runnerCalled = true;
    return { stdout: "[]", stderr: "" };
  };

  await assert.rejects(async () => {
    await updateAntigravityCanaryIssue({
      repo: "diegosouzapw/OmniRoute",
      profile: "cli",
      outcome: "drift",
      details: { projectId: "raw-project-id" },
      runner: mockRunner,
    });
  }, /redact|sensitive/i);

  assert.equal(runnerCalled, false);
});

test("updateAntigravityCanaryIssue fails redaction assertion on unredacted report file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-issue-test-"));
  const tmpReport = path.join(tmpDir, "report.json");
  fs.writeFileSync(
    tmpReport,
    JSON.stringify({
      authorization: "Bearer raw-token-here",
      profile: "cli",
    })
  );

  let runnerCalled = false;
  const mockRunner = async () => {
    runnerCalled = true;
    return { stdout: "[]", stderr: "" };
  };

  try {
    await assert.rejects(async () => {
      await updateAntigravityCanaryIssue({
        repo: "diegosouzapw/OmniRoute",
        profile: "cli",
        outcome: "drift",
        reportPath: tmpReport,
        runner: mockRunner,
      });
    }, /redact|sensitive/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.equal(runnerCalled, false);
});
