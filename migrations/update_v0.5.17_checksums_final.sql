-- Update version_checksums for v0.5.17 with correct multi-arch checksums
-- Run this in Adminer: https://app.vodou.ai/adminer-custom.php
-- Select database: usage_tracking

BEGIN TRANSACTION;

-- Delete existing checksums for version 0.5.17
DELETE FROM version_checksums 
WHERE version_id = (SELECT id FROM versions WHERE version_number = '0.5.17');

-- Insert correct checksums and download URLs for both architectures
INSERT INTO version_checksums (version_id, architecture, checksum_sha256, download_url)
VALUES 
    ((SELECT id FROM versions WHERE version_number = '0.5.17'), 'arm64', '378e998910d8c462fc67d98ea229225f18da5506ceaf98c5b90aad856e3a7994', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.17/OI-v0.5.17-arm64.tar.gz'),
    ((SELECT id FROM versions WHERE version_number = '0.5.17'), 'intel', '740ce13cad86089e9e50e36e9c514b513319226a57628ed32ce0a7b87d1affc9', 'https://github.com/OI-OS/OI-OS/releases/download/v0.5.17/OI-v0.5.17-intel.tar.gz');

-- Verify the update
SELECT 
    v.id,
    v.version_number,
    v.is_latest,
    v.is_forced_update,
    vc.architecture,
    SUBSTR(vc.checksum_sha256, 1, 20) || '...' as checksum_preview,
    vc.download_url
FROM versions v
LEFT JOIN version_checksums vc ON v.id = vc.version_id
WHERE v.version_number = '0.5.17'
ORDER BY vc.architecture;

COMMIT;
