import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertExistingEntries, buildLegacyEntries, entriesToSql } from './lib/legacy-entries.mjs';

const LOCK_KEY = 'legacy_object_migration_lock';

const flags = process.argv.slice(2);
if (flags.length !== 1 || !['--local', '--remote'].includes(flags[0])) {
  throw new Error('Usage: npm run migrate:objects -- --local|--remote');
}

const mode = flags[0];

function executeJson(command) {
  const output = execFileSync('npx', ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--command', command, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const payload = JSON.parse(output);
  if (!Array.isArray(payload) || payload.some((result) => !Array.isArray(result?.results))) {
    throw new Error('Wrangler returned an unexpected D1 JSON response');
  }
  return payload;
}

function lastRows(payload) {
  return payload.at(-1).results;
}

const token = randomUUID();
let lockHeld = false;
try {
  const lockPayload = executeJson(
    `INSERT INTO settings (key, value) VALUES ('${LOCK_KEY}', '${token}') ON CONFLICT(key) DO NOTHING; SELECT value FROM settings WHERE key = '${LOCK_KEY}';`,
  );
  if (lastRows(lockPayload)[0]?.value !== token) {
    throw new Error('Legacy object migration is already in progress');
  }
  lockHeld = true;

  const rows = lastRows(executeJson('SELECT * FROM objects ORDER BY key'));
  const entries = buildLegacyEntries(rows);
  const existingEntries = lastRows(executeJson('SELECT id, parent_id, name, storage_key FROM entries ORDER BY id'));
  assertExistingEntries(entries, existingEntries);
  if (entries.length === 0) {
    process.stdout.write('No legacy objects require migration.\n');
  } else {
    const directory = mkdtempSync(join(tmpdir(), 'ilist-migration-'));
    const file = join(directory, 'entries.sql');
    try {
      writeFileSync(file, entriesToSql(entries, token), 'utf8');
      execFileSync('npx', ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--file', file], { stdio: 'inherit' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write(`Migrated ${rows.length} objects into ${entries.length} entries.\n`);
  }
} finally {
  if (lockHeld) {
    executeJson(`DELETE FROM settings WHERE key = '${LOCK_KEY}' AND value = '${token}'`);
  }
}
