ALTER TABLE shares
ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 1 CHECK (auth_revision >= 1);
