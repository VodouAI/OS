-- Update version_checksums for v0.5.20 with complete multi-arch builds
-- Run this in Adminer: https://app.vodou.ai/adminer-custom.php
-- Select database: usage_tracking

BEGIN TRANSACTION;

-- Step 1: Set current latest to not latest
UPDATE versions SET is_latest = 0 WHERE is_latest = 1;

-- Step 2: Add or update version 0.5.20
-- Delete existing version if it exists (will cascade delete checksums)
DELETE FROM versions WHERE version_number = '0.5.20';

-- Insert version 0.5.20
INSERT INTO versions (version_number, release_notes, download_url, is_latest, is_forced_update)
VALUES (
    '0.5.20',
    '## OI OS v0.5.20

### Database Cleanup
- Removed unused server_configs table (migration 014)
- Cleaned up connection pool code (removed duplicate functions)
- Updated oi script (removed unused functions)

### Build System
- Updated version to 0.5.20 in all build scripts
- Fixed release build cleanup to preserve previous releases
- Multi-architecture support (arm64, intel)

### Installation
Download the appropriate archive for your architecture:
- **Apple Silicon (arm64)**: OI-v0.5.20-arm64.tar.gz
- **Intel Mac (x86_64)**: OI-v0.5.20-intel.tar.gz',
    'https://github.com/OI-OS/OI-OS/releases/tag/v0.5.20',
    1,
    0
);

-- Step 3: Delete existing checksums for version 0.5.20
DELETE FROM version_checksums 
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.20');

-- Step 4: Insert correct checksums and download URLs for both architectures
INSERT INTO version_checksums (version_id, architecture, checksum_sha256, download_url)
VALUES 
    ((SELECT id FROM versions WHERE version_number = '0.5.20'), 'arm64', '625ec2f40b322ff78b7afcb1d75a314eec94d72ceb91f663a7235f83e88d88b1', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.20/OI-v0.5.20-arm64.tar.gz'),
    ((SELECT id FROM versions WHERE version_number = '0.5.20'), 'intel', '44d63979f5374ec4b3264c7ec8966830a543447c198d26a833db9eb9118821c3', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.20/OI-v0.5.20-intel.tar.gz');

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
WHERE v.version_number = '0.5.20'
ORDER BY vc.architecture;

COMMIT;

