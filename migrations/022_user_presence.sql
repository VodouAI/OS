-- Migration 022: user_presence table for presence detection
CREATE TABLE IF NOT EXISTS user_presence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  activity_type TEXT,
  current_directory TEXT,
  git_branch TEXT,
  project_name TEXT,
  last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);
