-- Add version 0.5.11 to database
-- Run this in Adminer: https://app.vodou.ai/adminer-custom.php
-- Select database: usage_tracking

-- Step 1: Set current latest to not latest
UPDATE versions SET is_latest = 0 WHERE is_latest = 1;

-- Step 2: Add version 0.5.11
INSERT INTO versions (version_number, release_notes, download_url, is_latest, is_forced_update)
VALUES (
    '0.5.11',
    'Auto-update check system (1-2 times per day), Forced update support for critical fixes, Database cleanup (28 days), Conditional logging (90-95% reduction), Backup location: <project_root>/backups/',
    'https://github.com/OI-OS/OI-OS/releases/tag/v0.5.11',
    1,
    0
);

-- Step 3: Add checksums for both architectures
INSERT INTO version_checksums (version_id, architecture, checksum_sha256)
VALUES 
  ((SELECT id FROM versions WHERE version_number = '0.5.11'), 'arm64', '16eec8084b1f5c67bfb169f3679fab03ea0e007e86672db489f06f8415596f65'),
  ((SELECT id FROM versions WHERE version_number = '0.5.11'), 'intel', '57b2e7b4ef5878e97dd5538c72477fb885356675509632f938ee844ed493751e');

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
WHERE v.version_number = '0.5.11';
