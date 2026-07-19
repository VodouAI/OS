#!/bin/bash
# Run database migrations for Vodou-session-manager

DB_PATH="../../vodou-core.db"

if [ ! -f "$DB_PATH" ]; then
  echo "Error: Database not found at $DB_PATH"
  exit 1
fi

echo "Running migration: 001_create_mcp_sessions.sql"
sqlite3 "$DB_PATH" < 001_create_mcp_sessions.sql

# Add columns to intent_mappings if they don't exist
# SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check first
sqlite3 "$DB_PATH" <<'EOF'
-- Check if requires_session column exists
SELECT CASE 
  WHEN COUNT(*) = 0 THEN 
    'ALTER TABLE intent_mappings ADD COLUMN requires_session BOOLEAN DEFAULT 0;'
  ELSE 
    'SELECT "Column requires_session already exists";'
END
FROM pragma_table_info('intent_mappings')
WHERE name = 'requires_session';
EOF

# Actually add the column if it doesn't exist
if ! sqlite3 "$DB_PATH" "SELECT name FROM pragma_table_info('intent_mappings') WHERE name = 'requires_session';" | grep -q requires_session; then
  echo "Adding requires_session column..."
  sqlite3 "$DB_PATH" "ALTER TABLE intent_mappings ADD COLUMN requires_session BOOLEAN DEFAULT 0;"
fi

# Check if session_timeout column exists
if ! sqlite3 "$DB_PATH" "SELECT name FROM pragma_table_info('intent_mappings') WHERE name = 'session_timeout';" | grep -q session_timeout; then
  echo "Adding session_timeout column..."
  sqlite3 "$DB_PATH" "ALTER TABLE intent_mappings ADD COLUMN session_timeout INTEGER DEFAULT 3600;"
fi

echo "Migration completed!"

