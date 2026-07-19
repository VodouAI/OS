-- Update v0.5.16 with architecture-specific download URLs
-- Date: 2025-11-28
-- Description: Updates version_checksums table with GitHub release asset URLs for v0.5.16

BEGIN TRANSACTION;

-- Update arm64 download URL
UPDATE version_checksums 
SET download_url = 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.16/OI-v0.5.16-arm64.tar.gz'
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.16')
  AND architecture = 'arm64';

-- Update intel download URL
UPDATE version_checksums 
SET download_url = 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.16/OI-v0.5.16-intel.tar.gz'
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.16')
  AND architecture = 'intel';

-- Update windows download URL
UPDATE version_checksums 
SET download_url = 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.16/OI-v0.5.16-windows.zip'
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.16')
  AND architecture = 'windows';

-- Verify the updates
SELECT 
    v.version_number,
    vc.architecture,
    vc.download_url,
    SUBSTR(vc.checksum_sha256, 1, 16) || '...' as checksum_preview
FROM versions v
JOIN version_checksums vc ON v.id = vc.version_id
WHERE v.version_number = '0.5.16'
ORDER BY vc.architecture;

COMMIT;

