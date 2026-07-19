-- Add version 0.5.12 to database
-- Run this in Adminer: https://app.vodou.ai/adminer-custom.php
-- Select database: usage_tracking

-- Step 1: Set current latest to not latest
UPDATE versions SET is_latest = 0 WHERE is_latest = 1;

-- Step 2: Add or update version 0.5.12
-- Delete existing version if it exists (will cascade delete checksums)
DELETE FROM versions WHERE version_number = '0.5.12';

-- Insert version 0.5.12
INSERT INTO versions (version_number, release_notes, download_url, is_latest, is_forced_update)
VALUES (
    '0.5.12',
    '## OI OS v0.5.12

### Features
- Automatic OI.md file detection and parsing during server installation
- Automatic intent mapping extraction from SQL INSERT statements
- Automatic parameter extractor extraction from TOML code blocks
- Support for multiple OI.md formats (SQL, TOML, text)
- Enhanced MCP Server Installation Protocol documentation

### Installation
Download the appropriate archive for your architecture:
- **Apple Silicon (arm64)**: OI-v0.5.12-arm64.tar.gz
- **Intel Mac (x86_64)**: OI-v0.5.12-intel.tar.gz',
    'https://github.com/OI-OS/OI-OS/releases/tag/v0.5.12',
    1,
    0
);

-- Step 3: Add checksums for both architectures
-- Delete existing checksums if version already exists
DELETE FROM version_checksums 
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.12');

-- Insert checksums for both architectures
INSERT INTO version_checksums (version_id, architecture, checksum_sha256)
VALUES 
  ((SELECT id FROM versions WHERE version_number = '0.5.12'), 'arm64', '3d7a290252d5322dc10e1c05a0aec70836943dd5f4a69d1c823129a0af981b79'),
  ((SELECT id FROM versions WHERE version_number = '0.5.12'), 'intel', 'a38fc321c021e6ce3a614fe229afaa8b199000293f6804be075115732465b8d8');

-- Verify the insert
SELECT 
    v.id,
    v.version_number,
    v.is_latest,
    v.is_forced_update,
    vc.architecture,
    SUBSTR(vc.checksum_sha256, 1, 16) || '...' as checksum_preview
FROM versions v
LEFT JOIN version_checksums vc ON v.id = vc.version_id
WHERE v.version_number = '0.5.12';

