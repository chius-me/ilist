CREATE TRIGGER IF NOT EXISTS entries_prevent_storage_key_change
BEFORE UPDATE OF storage_key ON entries
WHEN OLD.storage_key IS NOT NEW.storage_key
BEGIN
  SELECT RAISE(ABORT, 'entry storage key is immutable');
END;
