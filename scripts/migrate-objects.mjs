import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertExistingEntries, buildLegacyEntries, entriesToSql } from './lib/legacy-entries.mjs';

const LOCK_KEY = 'legacy_object_migration_lock';
const RESERVATION_PREFIX = 'legacy_object_mutation_reservation_';
const LEASE_DURATION_MS = 300_000;
const LEASE_RENEWAL_INTERVAL_MS = 60_000;
const DRAIN_TIMEOUT_MS = 300_000;

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

function sqlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function leaseValue(owner, expiresAt) {
  return JSON.stringify({ owner, expires_at: expiresAt });
}

function liveLeaseCondition(column = 'value') {
  return `CASE
    WHEN json_valid(${column}) THEN COALESCE(CAST(json_extract(${column}, '$.expires_at') AS INTEGER), 0)
    ELSE 0
  END`;
}

function changed(command) {
  return lastRows(executeJson(`${command}; SELECT changes() AS changed`))[0]?.changed === 1;
}

function acquireLease(owner, now = Date.now()) {
  return changed(`INSERT INTO settings (key, value) VALUES (${sqlValue(LOCK_KEY)}, ${sqlValue(leaseValue(owner, now + LEASE_DURATION_MS))})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE ${liveLeaseCondition('settings.value')} <= ${now}`);
}

function renewLease(owner, now = Date.now()) {
  return changed(`UPDATE settings SET value = ${sqlValue(leaseValue(owner, now + LEASE_DURATION_MS))}
    WHERE key = ${sqlValue(LOCK_KEY)}
      AND json_valid(value)
      AND json_extract(value, '$.owner') = ${sqlValue(owner)}
      AND ${liveLeaseCondition()} > ${now}`);
}

function releaseLease(owner) {
  executeJson(`DELETE FROM settings
    WHERE key = ${sqlValue(LOCK_KEY)}
      AND json_valid(value)
      AND json_extract(value, '$.owner') = ${sqlValue(owner)}`);
}

function reservationCount() {
  return lastRows(executeJson(`SELECT COUNT(*) AS count FROM settings WHERE key GLOB ${sqlValue(`${RESERVATION_PREFIX}*`)}`))[0]?.count ?? 0;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReservationsToDrain(owner) {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (reservationCount() > 0) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for in-flight legacy object mutations to finish');
    }
    if (!renewLease(owner)) {
      throw new Error('Lost the legacy object migration lease while waiting for mutations');
    }
    await wait(100);
  }

  if (reservationCount() !== 0) {
    throw new Error('Legacy object mutations did not drain before the migration snapshot');
  }
}

function executeImport(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--file', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Wrangler import exited with status ${code}`));
    });
  });
}

async function importWithLeaseRenewal(file, owner) {
  let renewalFailure;
  let renewing = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(() => {
      if (!renewLease(owner)) throw new Error('Lost the legacy object migration lease during import');
    }).catch((error) => {
      renewalFailure = error;
    });
  }, LEASE_RENEWAL_INTERVAL_MS);
  try {
    await executeImport(file);
    await renewing;
    if (renewalFailure) throw renewalFailure;
  } finally {
    clearInterval(timer);
  }
}

const token = randomUUID();
let lockHeld = false;
try {
  if (!acquireLease(token)) {
    throw new Error('Legacy object migration is already in progress');
  }
  lockHeld = true;

  await waitForReservationsToDrain(token);
  if (!renewLease(token)) throw new Error('Lost the legacy object migration lease before the snapshot');
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
      if (!renewLease(token)) throw new Error('Lost the legacy object migration lease before import');
      await importWithLeaseRenewal(file, token);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write(`Migrated ${rows.length} objects into ${entries.length} entries.\n`);
  }
} finally {
  if (lockHeld) {
    releaseLease(token);
  }
}
