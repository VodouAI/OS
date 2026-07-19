-- Migration: Add per-architecture checksum support
-- Date: 2025-11-16
-- Description: Creates version_checksums table to store architecture-specific SHA256 checksums

CREATE TABLE IF NOT EXISTS version_checksums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL,
    architecture VARCHAR(20) NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(version_id, architecture),
    FOREIGN KEY(version_id) REFERENCES versions(id) ON DELETE CASCADE
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_version_checksums_version_arch ON version_checksums(version_id, architecture);

-- Example: Insert checksums for version 0.5.10
-- INSERT INTO version_checksums (version_id, architecture, checksum_sha256)
-- VALUES 
--     ((SELECT id FROM versions WHERE version_number = '0.5.10'), 'arm64', 'e1827c689c2893fec723ca540fd8836c510f89eec6ae9f4b0a98f0609cdb0d9c'),
--     ((SELECT id FROM versions WHERE version_number = '0.5.10'), 'intel', '0325855feefbef7f7920a452243bba8c9826d9d7801f31f1bb4c2069d6a78bfe');

