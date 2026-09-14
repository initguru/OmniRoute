import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core";
import { cleanupAgenticConversations, runAutoCleanup } from "../../src/lib/db/cleanup";

test.after(() => {
  resetDbInstance();
});

test.beforeEach(() => {
  const db = getDbInstance();
  db.exec("DELETE FROM conversation_turn_nodes; DELETE FROM agentic_conversations;");
});

test("cleanupAgenticConversations removes expired conversations, their turns, and orphaned turns", async () => {
  const db = getDbInstance();
  const now = Date.now();
  const eightDaysAgo = new Date(now - 8 * 86_400_000).toISOString();
  const oneDayAgo = new Date(now - 1 * 86_400_000).toISOString();

  // 1. Expired conversation (> 7 days) with child turn nodes
  const expiredConvId = "conv_expired_1";
  db.prepare(
    `INSERT INTO agentic_conversations (id, api_key_id, fingerprint_hash, last_message_count, last_messages_hash, turn_count, first_seen_at, last_seen_at)
     VALUES (?, null, 'fp_exp', 0, '', 2, ?, ?)`
  ).run(expiredConvId, eightDaysAgo, eightDaysAgo);

  db.prepare(
    `INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     VALUES (?, ?, null, 'user', 'hash_exp_1', null, ?, ?)`
  ).run("node_exp_1", expiredConvId, eightDaysAgo, eightDaysAgo);

  db.prepare(
    `INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     VALUES (?, ?, 'node_exp_1', 'assistant', 'hash_exp_2', null, ?, ?)`
  ).run("node_exp_2", expiredConvId, eightDaysAgo, eightDaysAgo);

  // 2. Active conversation (< 7 days) with child turn nodes
  const activeConvId = "conv_active_1";
  db.prepare(
    `INSERT INTO agentic_conversations (id, api_key_id, fingerprint_hash, last_message_count, last_messages_hash, turn_count, first_seen_at, last_seen_at)
     VALUES (?, null, 'fp_act', 0, '', 2, ?, ?)`
  ).run(activeConvId, oneDayAgo, oneDayAgo);

  db.prepare(
    `INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     VALUES (?, ?, null, 'user', 'hash_act_1', null, ?, ?)`
  ).run("node_act_1", activeConvId, oneDayAgo, oneDayAgo);

  db.prepare(
    `INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     VALUES (?, ?, 'node_act_1', 'assistant', 'hash_act_2', null, ?, ?)`
  ).run("node_act_2", activeConvId, oneDayAgo, oneDayAgo);

  // 3. Orphaned conversation_turn_node with nonexistent conversation_id
  const orphanConvId = "conv_nonexistent_orphan";
  db.prepare(
    `INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     VALUES (?, ?, null, 'user', 'hash_orphan_1', null, ?, ?)`
  ).run("node_orphan_1", orphanConvId, eightDaysAgo, eightDaysAgo);

  // 4. Run cleanup
  const cleanupResult = await cleanupAgenticConversations();

  // 5. Assert:
  // Expired conversation and all its turn nodes are deleted
  const expiredConv = db
    .prepare("SELECT * FROM agentic_conversations WHERE id = ?")
    .get(expiredConvId);
  assert.equal(expiredConv, undefined, "Expired conversation should be deleted");

  const expiredTurns = db
    .prepare("SELECT * FROM conversation_turn_nodes WHERE conversation_id = ?")
    .all(expiredConvId);
  assert.equal(expiredTurns.length, 0, "Expired conversation turn nodes should be deleted");

  // Active conversation and all its turn nodes are completely preserved
  const activeConv = db
    .prepare("SELECT * FROM agentic_conversations WHERE id = ?")
    .get(activeConvId);
  assert.ok(activeConv, "Active conversation should be preserved");

  const activeTurns = db
    .prepare("SELECT * FROM conversation_turn_nodes WHERE conversation_id = ?")
    .all(activeConvId);
  assert.equal(activeTurns.length, 2, "Active conversation turn nodes should be preserved");

  // Orphaned turn nodes are deleted
  const orphanTurns = db
    .prepare("SELECT * FROM conversation_turn_nodes WHERE id = ?")
    .all("node_orphan_1");
  assert.equal(orphanTurns.length, 0, "Orphaned turn node should be deleted");

  // Result verification
  assert.equal(cleanupResult.errors, 0, "No errors expected during cleanup");
  assert.ok(
    cleanupResult.deleted >= 4,
    "Should report deleted rows count (1 conv + 2 expired turns + 1 orphan)"
  );
});

test("cleanupAgenticConversations respects batchSize and maxConversations options", async () => {
  const db = getDbInstance();
  const now = Date.now();
  const eightDaysAgo = new Date(now - 8 * 86_400_000).toISOString();

  for (let i = 0; i < 5; i++) {
    const id = `conv_batch_${i}`;
    db.prepare(
      `INSERT INTO agentic_conversations (id, api_key_id, fingerprint_hash, last_message_count, last_messages_hash, turn_count, first_seen_at, last_seen_at)
       VALUES (?, null, 'fp_batch', 0, '', 1, ?, ?)`
    ).run(id, eightDaysAgo, eightDaysAgo);
    db.prepare(
      `INSERT INTO conversation_turn_nodes (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
       VALUES (?, ?, null, 'user', 'hash_batch', null, ?, ?)`
    ).run(`node_batch_${i}`, id, eightDaysAgo, eightDaysAgo);
  }

  // With maxConversations: 2, batchSize: 1
  const result = await cleanupAgenticConversations({
    batchSize: 1,
    maxConversations: 2,
    yieldDelayMs: 1,
  });
  assert.equal(result.errors, 0);

  const remaining = db.prepare("SELECT COUNT(*) as count FROM agentic_conversations").get() as {
    count: number;
  };
  assert.equal(remaining.count, 3, "Only 2 of 5 expired conversations should have been deleted");
});

test("runAutoCleanup registers agenticConversations in results", async () => {
  const result = await runAutoCleanup();
  if (result.results && Object.keys(result.results).length > 0) {
    assert.ok(
      "agenticConversations" in result.results,
      "agenticConversations must be present in runAutoCleanup results"
    );
    assert.ok(typeof result.results.agenticConversations.deleted === "number");
    assert.ok(typeof result.results.agenticConversations.errors === "number");
  }
});
