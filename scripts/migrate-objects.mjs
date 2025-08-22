import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLegacyEntries, entriesToSql } from './lib/legacy-entries.mjs';

const flags = process.argv.slice(2);
if (flags.length !== 1 || !['--local', '--remote'].includes(flags[0])) {
  throw new Error('Usage: npm run migrate:objects -- --local|--remote');
}

const mode = flags[0];
const output = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--command', 'SELECT * FROM objects ORDER BY key', '--json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const payload = JSON.parse(output);
if (!Array.isArray(payload) || !Array.isArray(payload[0]?.results)) {
  throw new Error('Wrangler returned an unexpected D1 JSON response');
}

const rows = payload[0].results;
const entries = buildLegacyEntries(rows);
if (entries.length === 0) {
  process.stdout.write('No legacy objects require migration.\n');
  process.exit(0);
}
const directory = mkdtempSync(join(tmpdir(), 'ilist-migration-'));
const file = join(directory, 'entries.sql');

try {
  writeFileSync(file, entriesToSql(entries), 'utf8');
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'ilist-db', mode, '--file', file], { stdio: 'inherit' });
  process.stdout.write(`Migrated ${rows.length} objects into ${entries.length} entries.\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
