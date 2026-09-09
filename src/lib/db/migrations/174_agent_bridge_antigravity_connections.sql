-- 174: durable AgentBridge-to-Antigravity connection bindings.
-- The table intentionally stores only the existing provider_connections id;
-- credentials and client-profile metadata remain on provider_connections.

CREATE TABLE IF NOT EXISTS agent_bridge_antigravity_connections (
  agent_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_bridge_antigravity_connections_connection
  ON agent_bridge_antigravity_connections(connection_id);
