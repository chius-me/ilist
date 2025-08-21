import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { listDirectory, resolveEntryPath } from '../../src/worker/entries';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

async function seed(): Promise<void> {
  const now = '2026-07-10T00:00:00.000Z';
  await db().batch([
    db().prepare(`INSERT INTO entries VALUES (?, ?, ?, 'folder', NULL, 0, NULL, NULL, 'ready', 1, 0, '', ?, ?)`).bind(
      'r2', 'root', 'R2', now, now,
    ),
    db().prepare(`INSERT INTO entries VALUES (?, ?, ?, 'folder', NULL, 0, NULL, NULL, 'ready', 1, 0, '', ?, ?)`).bind(
      'private', 'r2', 'Private', now, now,
    ),
    db().prepare(`UPDATE entries SET is_public = 0 WHERE id = 'private'`),
    db().prepare(`INSERT INTO entries VALUES (?, ?, ?, 'file', ?, 12, 'text/plain', 'etag', 'ready', 1, 0, '', ?, ?)`).bind(
      'readme', 'r2', 'README.txt', 'blobs/readme', now, now,
    ),
  ]);
}

describe('entries', () => {
  beforeEach(async () => {
    await db().prepare("DELETE FROM entries WHERE id <> 'root'").run();
  });

  it('resolves a decoded virtual path', async () => {
    await seed();
    await expect(resolveEntryPath(db(), '/R2/README.txt', true)).resolves.toMatchObject({ id: 'readme' });
  });

  it('filters hidden children for guests and returns capabilities for admins', async () => {
    await seed();
    const guest = await listDirectory(db(), '/R2', false);
    expect(guest.items.map((entry) => entry.name)).toEqual(['README.txt']);
    expect(guest.items[0].capabilities.rename).toBe(false);

    const admin = await listDirectory(db(), '/R2', true);
    expect(admin.items.map((entry) => entry.name)).toEqual(['Private', 'README.txt']);
    expect(admin.items[0].capabilities.rename).toBe(true);
  });
});
