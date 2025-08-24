import { describe, expect, it } from 'vitest';
import { assertExistingEntries, buildLegacyEntries, entriesToSql } from '../../scripts/lib/legacy-entries.mjs';
import {
  LOCAL_MIGRATION_LEASE_DURATION_MS,
  REMOTE_MIGRATION_LEASE_DURATION_MS,
  migrationLeaseDuration,
  migrationLeaseValue,
} from '../../scripts/lib/legacy-migration-lease.mjs';

describe('legacy object migration', () => {
  it('uses an owner-bound remote lease that covers a complete remote import', () => {
    const now = 1_000;

    expect(migrationLeaseDuration('--local')).toBe(LOCAL_MIGRATION_LEASE_DURATION_MS);
    expect(migrationLeaseDuration('--remote')).toBe(REMOTE_MIGRATION_LEASE_DURATION_MS);
    expect(REMOTE_MIGRATION_LEASE_DURATION_MS).toBeGreaterThan(LOCAL_MIGRATION_LEASE_DURATION_MS);
    expect(JSON.parse(migrationLeaseValue('migration-owner', now, '--remote'))).toEqual({
      owner: 'migration-owner',
      expires_at: now + REMOTE_MIGRATION_LEASE_DURATION_MS,
    });
  });

  it('creates each folder once and preserves the physical key', () => {
    const rows = [
      {
        key: '资料/项目/a.txt',
        name: 'a.txt',
        size: 4,
        content_type: 'text/plain',
        etag: 'etag-a',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 1,
        sort_order: 0,
        description: '',
      },
      {
        key: '资料/项目/b.txt',
        name: 'b.txt',
        size: 5,
        content_type: 'text/plain',
        etag: 'etag-b',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 0,
        sort_order: 1,
        description: 'hidden',
      },
    ];
    const entries = buildLegacyEntries(rows);
    expect(entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.name)).toEqual(['资料', '项目']);
    expect(entries.find((entry) => entry.name === 'a.txt')).toMatchObject({
      storage_key: '资料/项目/a.txt',
      parent_path: '资料/项目',
    });
    expect(buildLegacyEntries(rows).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });

  it.each(['', '/', '///'])('rejects an empty legacy key %j', (key) => {
    expect(() =>
      buildLegacyEntries([
        {
          key,
          name: 'ignored.txt',
          size: 1,
          content_type: 'text/plain',
          etag: 'etag',
          updated_at: '2026-07-10T00:00:00.000Z',
          is_public: 1,
          sort_order: 0,
          description: '',
        },
      ]),
    ).toThrow('invalid key');
  });

  it('rejects a deterministic ID with a different storage key', () => {
    const [entry] = buildLegacyEntries([
      {
        key: 'legacy.txt',
        name: 'legacy.txt',
        size: 1,
        content_type: 'text/plain',
        etag: 'etag',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 1,
        sort_order: 0,
        description: '',
      },
    ]);

    expect(() => assertExistingEntries([entry], [{ id: entry.id, parent_id: 'root', name: entry.name, storage_key: 'other.txt' }])).toThrow(
      'storage key',
    );
  });

  it('rejects an existing sibling or storage-key conflict that does not share the deterministic ID', () => {
    const [entry] = buildLegacyEntries([
      {
        key: 'legacy.txt',
        name: 'legacy.txt',
        size: 1,
        content_type: 'text/plain',
        etag: 'etag',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 1,
        sort_order: 0,
        description: '',
      },
    ]);

    expect(() => assertExistingEntries([entry], [{ id: 'other-id', parent_id: 'root', name: entry.name, storage_key: entry.storage_key }])).toThrow(
      'collision',
    );
  });

  it('splits a large description into D1-safe Wrangler import statements without truncation', () => {
    const description = 'x'.repeat(180_000);
    const [entry] = buildLegacyEntries([
      {
        key: 'large.txt',
        name: 'large.txt',
        size: 1,
        content_type: 'text/plain',
        etag: 'etag',
        updated_at: '2026-07-10T00:00:00.000Z',
        is_public: 1,
        sort_order: 0,
        description,
      },
    ]);
    const sql = entriesToSql([entry], 'test-token');
    const chunks = [...sql.matchAll(/description = description \|\| '([^']*)'/g)].map((match) => match[1]);

    expect(sql).not.toContain('INSERT OR IGNORE');
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
    expect(chunks.join('')).toBe(description);
    expect(Math.max(...sql.split(';').map((statement) => Buffer.byteLength(statement, 'utf8')))).toBeLessThan(100_000);
  });
});
