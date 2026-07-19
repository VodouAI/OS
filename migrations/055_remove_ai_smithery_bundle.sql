-- Migration 055: Remove local MCP-servers/ai.smithery bundle entries (deprecated; not shipped).
-- Matches: registry-style name ai.smithery/... or command/args containing ai.smithery path.
-- Idempotent.

DELETE FROM intent_mappings WHERE server_name LIKE 'ai.smithery/%'
   OR server_name IN (
     SELECT name FROM mcp_servers
     WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
   );

DELETE FROM parameter_rules WHERE server_name LIKE 'ai.smithery/%'
   OR server_name IN (
     SELECT name FROM mcp_servers
     WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
   );

DELETE FROM id_mappings WHERE server_name LIKE 'ai.smithery/%'
   OR server_name IN (
     SELECT name FROM mcp_servers
     WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
   );

DELETE FROM intent_embeddings WHERE server_name LIKE 'ai.smithery/%'
   OR server_name IN (
     SELECT name FROM mcp_servers
     WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
   );

DELETE FROM mcp_session_calls WHERE session_id IN (
  SELECT session_id FROM mcp_sessions WHERE server_name LIKE 'ai.smithery/%'
     OR server_name IN (
       SELECT name FROM mcp_servers
       WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
     )
);
DELETE FROM mcp_sessions WHERE server_name LIKE 'ai.smithery/%'
   OR server_name IN (
     SELECT name FROM mcp_servers
     WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
   );

DELETE FROM script_jobs WHERE server_name LIKE 'ai.smithery/%'
   OR working_directory LIKE '%ai.smithery%';

DELETE FROM script_intent_metadata WHERE target_server LIKE 'ai.smithery/%';

DELETE FROM script_registry WHERE server_name LIKE 'ai.smithery/%'
   OR working_directory LIKE '%ai.smithery%';

DELETE FROM server_credentials WHERE server_id IN (
  SELECT id FROM mcp_servers
  WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
);

DELETE FROM server_roots WHERE server_id IN (
  SELECT id FROM mcp_servers
  WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
);

DELETE FROM server_progress WHERE server_id IN (
  SELECT id FROM mcp_servers
  WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
);

DELETE FROM tools WHERE server_id IN (
  SELECT id FROM mcp_servers
  WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
);

DELETE FROM prompts WHERE server_id IN (
  SELECT id FROM mcp_servers
  WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
);

DELETE FROM resources WHERE server_id IN (
  SELECT id FROM mcp_servers
  WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%'
);

DELETE FROM mcp_servers
WHERE command LIKE '%ai.smithery%' OR args LIKE '%ai.smithery%' OR name LIKE 'ai.smithery/%';
