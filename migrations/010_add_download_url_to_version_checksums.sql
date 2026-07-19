-- Migration: Add download_url column to version_checksums table
-- Date: 2025-11-28
-- Description: Adds download_url column to store architecture-specific GitHub release asset URLs

BEGIN TRANSACTION;

-- Add download_url column to version_checksums table
ALTER TABLE version_checksums ADD COLUMN download_url TEXT;

-- Update index comment/documentation
-- Note: The existing index idx_version_checksums_version_arch already supports efficient lookups by version_id and architecture

COMMIT;

