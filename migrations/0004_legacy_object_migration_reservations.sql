DROP TRIGGER IF EXISTS objects_block_insert_during_legacy_migration;
DROP TRIGGER IF EXISTS objects_block_update_during_legacy_migration;
DROP TRIGGER IF EXISTS objects_block_delete_during_legacy_migration;

CREATE TRIGGER objects_block_insert_during_legacy_migration
BEFORE INSERT ON objects
WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'legacy_object_migration_lock')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key GLOB 'legacy_object_mutation_reservation_*')
BEGIN
  SELECT RAISE(ABORT, 'legacy object migration is in progress');
END;

CREATE TRIGGER objects_block_update_during_legacy_migration
BEFORE UPDATE ON objects
WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'legacy_object_migration_lock')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key GLOB 'legacy_object_mutation_reservation_*')
BEGIN
  SELECT RAISE(ABORT, 'legacy object migration is in progress');
END;

CREATE TRIGGER objects_block_delete_during_legacy_migration
BEFORE DELETE ON objects
WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'legacy_object_migration_lock')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key GLOB 'legacy_object_mutation_reservation_*')
BEGIN
  SELECT RAISE(ABORT, 'legacy object migration is in progress');
END;
