-- 092: remove the dalle MCP server.
--
-- dalle (OpenAI image generation) left the tree on 2026-09-09: the packer no
-- longer ships MCP-servers/dalle, install.sh no longer builds it and
-- start-vodou-services.sh no longer connects it. An existing install still
-- carries the row migration 083 registered and 084 deactivated; left alone it
-- points at a dist/index.js that is gone, so it would sit in Apps as a server
-- that can never start. Delete the row and everything keyed to it.
--
-- Idempotent: DELETE by name, safe to re-run. server_credentials is untouched;
-- dalle read OPENAI_API_KEY from the environment and never stored a credential.
DELETE FROM tools WHERE server_id IN (SELECT id FROM mcp_servers WHERE name = 'dalle');
DELETE FROM intent_embeddings WHERE server_name = 'dalle';
DELETE FROM intent_mappings WHERE server_name = 'dalle';
DELETE FROM mcp_servers WHERE name = 'dalle';
