-- Migration 054: Remove bundled CodeGraphContext MCP (not part of core ship; install separately if needed).
-- Idempotent: safe if server already absent.

DELETE FROM intent_mappings WHERE server_name = 'CodeGraphContext';

DELETE FROM parameter_rules WHERE server_name = 'CodeGraphContext';

DELETE FROM id_mappings WHERE server_name = 'CodeGraphContext';

DELETE FROM intent_embeddings WHERE server_name = 'CodeGraphContext';

DELETE FROM mcp_session_calls WHERE session_id IN (
  SELECT session_id FROM mcp_sessions WHERE server_name = 'CodeGraphContext'
);
DELETE FROM mcp_sessions WHERE server_name = 'CodeGraphContext';

DELETE FROM script_jobs WHERE server_name = 'CodeGraphContext';

DELETE FROM script_intent_metadata WHERE target_server = 'CodeGraphContext';

DELETE FROM script_registry WHERE server_name = 'CodeGraphContext';

DELETE FROM server_credentials WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'CodeGraphContext'
);

DELETE FROM server_roots WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'CodeGraphContext'
);

DELETE FROM server_progress WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'CodeGraphContext'
);

DELETE FROM tools WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'CodeGraphContext'
);

DELETE FROM prompts WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'CodeGraphContext'
);

DELETE FROM resources WHERE server_id IN (
  SELECT id FROM mcp_servers WHERE name = 'CodeGraphContext'
);

DELETE FROM mcp_servers WHERE name = 'CodeGraphContext';
