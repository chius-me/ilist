ALTER TABLE shares
ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0);

ALTER TABLE shares
ADD COLUMN max_downloads INTEGER DEFAULT NULL CHECK (max_downloads IS NULL OR max_downloads >= 1);

ALTER TABLE shares
ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0);
