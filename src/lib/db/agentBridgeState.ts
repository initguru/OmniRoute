/**
 * Database module: AgentBridgeState
 * CRUD operations for agent_bridge_state table.
 */

import { getDbInstance } from "./core.ts";
import type { AgentBridgeStateRow } from "./_rowTypes.ts";

// SQLite stores booleans as 0/1 integers
interface AgentBridgeStateDbRow {
  agent_id: string;
  dns_enabled: number;
  cert_trusted: number;
  setup_completed: number;
  last_started_at: string | null;
  last_error: string | null;
}

function mapRow(row: AgentBridgeStateDbRow): AgentBridgeStateRow {
  return {
    agent_id: row.agent_id,
    dns_enabled: row.dns_enabled === 1,
    cert_trusted: row.cert_trusted === 1,
    setup_completed: row.setup_completed === 1,
    last_started_at: row.last_started_at,
    last_error: row.last_error,
  };
}

export function getAllAgentBridgeStates(): AgentBridgeStateRow[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM agent_bridge_state ORDER BY agent_id ASC")
    .all() as AgentBridgeStateDbRow[];
  return rows.map(mapRow);
}

export function getAgentBridgeState(agentId: string): AgentBridgeStateRow | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM agent_bridge_state WHERE agent_id = ?").get(agentId) as
    AgentBridgeStateDbRow | undefined;
  return row ? mapRow(row) : null;
}

export function upsertAgentBridgeState(
  row: Partial<AgentBridgeStateRow> & { agent_id: string }
): void {
  const db = getDbInstance();
  const existing = getAgentBridgeState(row.agent_id);

  if (!existing) {
    db.prepare(
      `INSERT INTO agent_bridge_state
         (agent_id, dns_enabled, cert_trusted, setup_completed, last_started_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      row.agent_id,
      row.dns_enabled !== undefined ? (row.dns_enabled ? 1 : 0) : 0,
      row.cert_trusted !== undefined ? (row.cert_trusted ? 1 : 0) : 0,
      row.setup_completed !== undefined ? (row.setup_completed ? 1 : 0) : 0,
      row.last_started_at ?? null,
      row.last_error ?? null
    );
  } else {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (row.dns_enabled !== undefined) {
      fields.push("dns_enabled = ?");
      values.push(row.dns_enabled ? 1 : 0);
    }
    if (row.cert_trusted !== undefined) {
      fields.push("cert_trusted = ?");
      values.push(row.cert_trusted ? 1 : 0);
    }
    if (row.setup_completed !== undefined) {
      fields.push("setup_completed = ?");
      values.push(row.setup_completed ? 1 : 0);
    }
    if (row.last_started_at !== undefined) {
      fields.push("last_started_at = ?");
      values.push(row.last_started_at);
    }
    if (row.last_error !== undefined) {
      fields.push("last_error = ?");
      values.push(row.last_error);
    }

    if (fields.length === 0) return;

    values.push(row.agent_id);
    db.prepare(`UPDATE agent_bridge_state SET ${fields.join(", ")} WHERE agent_id = ?`).run(
      ...values
    );
  }
}

function isEligibleAntigravityConnection(connectionId: string): boolean {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT provider, is_active, provider_specific_data
       FROM provider_connections
       WHERE id = ?`
    )
    .get(connectionId) as
    | {
        provider: string | null;
        is_active: number;
        provider_specific_data: string | null;
      }
    | undefined;
  if (!row || row.is_active !== 1 || !["antigravity", "agy"].includes(row.provider || "")) {
    return false;
  }
  try {
    const data = row.provider_specific_data ? JSON.parse(row.provider_specific_data) : null;
    return data?.clientProfile === "cli" || data?.clientProfile === "ide";
  } catch {
    return false;
  }
}

export async function setAgentBridgeAntigravityConnection(
  agentId: string,
  connectionId: string
): Promise<void> {
  if (agentId !== "antigravity" || !isEligibleAntigravityConnection(connectionId)) {
    throw new Error("AgentBridge requires an eligible Antigravity connection");
  }
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO agent_bridge_antigravity_connections (agent_id, connection_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(agent_id) DO UPDATE SET
       connection_id = excluded.connection_id,
       updated_at = excluded.updated_at`
  ).run(agentId, connectionId);
}

export async function getAgentBridgeAntigravityConnection(agentId: string): Promise<string | null> {
  if (agentId !== "antigravity") return null;
  const db = getDbInstance();
  const row = db
    .prepare("SELECT connection_id FROM agent_bridge_antigravity_connections WHERE agent_id = ?")
    .get(agentId) as { connection_id: string } | undefined;
  if (!row || !isEligibleAntigravityConnection(row.connection_id)) return null;
  return row.connection_id;
}

export async function resolveVerifiedAgentBridgeAntigravityConnection({
  agentId,
  connectionId,
}: {
  agentId: string;
  connectionId: string | null;
}): Promise<string | null> {
  if (!connectionId || !isEligibleAntigravityConnection(connectionId)) return null;
  const boundConnectionId = await getAgentBridgeAntigravityConnection(agentId);
  return boundConnectionId === connectionId ? connectionId : null;
}

export function setLastStarted(agentId: string, ts: string): void {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO agent_bridge_state (agent_id, last_started_at)
     VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET last_started_at = excluded.last_started_at`
  ).run(agentId, ts);
}

export function setLastError(agentId: string, err: string | null): void {
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO agent_bridge_state (agent_id, last_error)
     VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET last_error = excluded.last_error`
  ).run(agentId, err);
}
