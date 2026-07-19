-- Intent embeddings for semantic routing
-- 384-dimensional vectors from AllMiniLML6V2 (same model as memory search)
-- ON DELETE CASCADE ensures server removal cleans up embeddings automatically

CREATE TABLE IF NOT EXISTS intent_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    source_type TEXT NOT NULL,  -- 'description','keyword','synthetic','user_feedback'
    source_text TEXT NOT NULL,
    embedding BLOB NOT NULL,    -- 384 x f32 = 1536 bytes
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_name) REFERENCES mcp_servers(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intent_embeddings_server ON intent_embeddings(server_name);
CREATE INDEX IF NOT EXISTS idx_intent_embeddings_tool ON intent_embeddings(server_name, tool_name);
