-- Update version_checksums for v0.5.17 with complete multi-arch builds
-- Run this in Adminer: https://app.vodou.ai/adminer-custom.php
-- Select database: usage_tracking

BEGIN TRANSACTION;

-- Delete existing checksums for version 0.5.17
DELETE FROM version_checksums 
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.17');

-- Insert correct checksums and download URLs for both architectures (complete builds)
INSERT INTO version_checksums (version_id, architecture, checksum_sha256, download_url)
VALUES 
    ((SELECT id FROM versions WHERE version_number = '0.5.17'), 'arm64', 'f81c906bcdc857f9ad417d97a1f76dcfcc15ca73ebe8b57c9b36d39137d72c70', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.17/OI-v0.5.17-arm64.tar.gz'),
    ((SELECT id FROM versions WHERE version_number = '0.5.17'), 'intel', 'f57df3f5d50dd7175f3fd9054b11f1fbe6cad8be9e521fea0e649221819cea64', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.17/OI-v0.5.17-intel.tar.gz');

-- Verify the update
SELECT 
    v.version_number,
    vc.architecture,
    SUBSTR(vc.checksum_sha256, 1, 20) || '...' as checksum_preview,
    vc.download_url
FROM versions v
JOIN version_checksums vc ON v.id = vc.version_id
WHERE v.version_number = '0.5.17'
ORDER BY vc.architecture;

COMMIT;
