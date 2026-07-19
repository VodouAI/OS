-- Migration: Remove legacy checksum_sha256 column from versions table
-- Date: 2025-11-16
-- Description: Removes the legacy checksum_sha256 column since we now use per-architecture checksums in version_checksums table

BEGIN TRANSACTION;

-- Create new versions table without checksum_sha256
CREATE TABLE versions_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_number VARCHAR(20) NOT NULL UNIQUE,
    release_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    release_notes TEXT,
    download_url TEXT,
    is_latest BOOLEAN DEFAULT 0,
    is_forced_update BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data (excluding checksum_sha256)
INSERT INTO versions_new (id, version_number, release_date, release_notes, download_url, is_latest, is_forced_update, created_at, updated_at)
SELECT id, version_number, release_date, release_notes, download_url, is_latest, is_forced_update, created_at, updated_at
FROM versions;

-- Drop old table
DROP TABLE versions;

-- Rename new table
ALTER TABLE versions_new RENAME TO versions;

COMMIT;

