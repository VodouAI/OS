-- Update version_checksums for v0.5.21 with complete multi-arch builds
-- Run this in Adminer: https://app.vodou.ai/adminer-custom.php
-- Select database: usage_tracking

BEGIN TRANSACTION;

-- Step 1: Set current latest to not latest
UPDATE versions SET is_latest = 0 WHERE is_latest = 1;

-- Step 2: Add or update version 0.5.21
-- Delete existing version if it exists (will cascade delete checksums)
DELETE FROM versions WHERE version_number = '0.5.21';

-- Insert version 0.5.21
INSERT INTO versions (version_number, release_notes, download_url, is_latest, is_forced_update)
VALUES (
    '0.5.21',
    '## OI OS v0.5.21

### New Features
- Added clean extractors.toml.template for fresh installations
- Template includes general rules + mcp-monitor + browser-tools-stdio

### Build System
- Updated build scripts to use template for new installs
- Multi-architecture support (arm64, intel)

### Installation
Download the appropriate archive for your architecture:
- **Apple Silicon (arm64)**: OI-v0.5.21-arm64.tar.gz
- **Intel Mac (x86_64)**: OI-v0.5.21-intel.tar.gz',
    'https://github.com/OI-OS/OI-OS/releases/tag/v0.5.21',
    1,
    0
);

-- Step 3: Delete existing checksums for version 0.5.21
DELETE FROM version_checksums
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.21');

-- Step 4: Insert correct checksums and download URLs for both architectures
INSERT INTO version_checksums (version_id, architecture, checksum_sha256, download_url)
VALUES
    ((SELECT id FROM versions WHERE version_number = '0.5.21'), 'arm64', '5449446741f202648972a55113bf0ff988d40f1198b0828769fe8c46322d8270', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.21/OI-v0.5.21-arm64.tar.gz'),
    ((SELECT id FROM versions WHERE version_number = '0.5.21'), 'intel', '70ce604cd30f3fac34f78c0c70f4e83223eb5be1e5724e605a9226de542f1541', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.21/OI-v0.5.21-intel.tar.gz');

-- Verify the update
SELECT
    v.version_number,
    v.is_latest,
    v.is_forced_update,
    vc.architecture,
    SUBSTR(vc.checksum_sha256, 1, 20) || '...' as checksum_preview,
    vc.download_url
FROM versions v
JOIN version_checksums vc ON v.id = vc.version_id
WHERE v.version_number = '0.5.21'
ORDER BY vc.architecture;

COMMIT;

