-- Migration 053: Remove legacy OI-playwright-mcp (replaced by chrome-devtools-mcp / Chrome DevTools MCP).
-- Idempotent: safe if server already absent.

DELETE FROM intent_mappings WHERE server_name = 'OI-playwright-mcp';

DELETE FROM parameter_rules WHERE server_name = 'OI-playwright-mcp';

DELETE FROM id_mappings WHERE server_name = 'OI-playwright-mcp';

DELETE FROM intent_embeddings WHERE server_name = 'OI-playwright-mcp';

-- Session rows (no FK to mcp_servers)
DELETE FROM mcp_session_calls WHERE session_id IN (
  SELECT session_id FROM mcp_sessions WHERE server_name = 'OI-playwright-mcp'
);
DELETE FROM mcp_sessions WHERE server_name = 'OI-playwright-mcp';

-- script_jobs / script_intent_metadata reference script_registry — delete children first
DELETE FROM script_jobs WHERE server_name = 'OI-playwright-mcp';

DELETE FROM script_intent_metadata WHERE target_server = 'OI-playwright-mcp';

DELETE FROM script_registry WHERE server_name = 'OI-playwright-mcp';

DELETE FROM server_credentials WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'OI-playwright-mcp'
);

DELETE FROM server_roots WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'OI-playwright-mcp'
);

DELETE FROM server_progress WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'OI-playwright-mcp'
);

DELETE FROM tools WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'OI-playwright-mcp'
);

DELETE FROM prompts WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'OI-playwright-mcp'
);

DELETE FROM resources WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'OI-playwright-mcp'
);

DELETE FROM mcp_servers WHERE name = 'OI-playwright-mcp';
