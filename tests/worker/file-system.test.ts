import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFolder, moveEntries, patchEntry, setEntriesVisibility } from '../../src/worker/file-system';
import { getEntryById } from '../../src/worker/db';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

describe('file system mutations', () => {
  it('creates a real empty folder that inherits visibility', async () => {
    const folder = await createFolder(db(), { parentId: 'root', name: '资料' });
    expect(folder).toMatchObject({ name: '资料', kind: 'folder', isPublic: true });
    expect(await getEntryById(db(), folder.id)).toMatchObject({ parent_id: 'root', storage_key: null });
  });

  it('renames metadata without changing a file storage key', async () => {
    const now = new Date().toISOString();
    await db().prepare(`INSERT INTO entries VALUES (?, 'root', ?, 'file', ?, 4, 'text/plain', 'e', 'ready', 1, 0, '', ?, ?)`).bind(
      'file-a', 'a.txt', 'blobs/file-a', now, now,
    ).run();
    await patchEntry(db(), 'file-a', { name: 'b.txt' });
    expect(await getEntryById(db(), 'file-a')).toMatchObject({ name: 'b.txt', storage_key: 'blobs/file-a' });
  });

  it('moves entries and rejects a folder cycle', async () => {
    const parent = await createFolder(db(), { parentId: 'root', name: 'Parent' });
    const child = await createFolder(db(), { parentId: parent.id, name: 'Child' });
    await expect(moveEntries(db(), [parent.id], child.id)).resolves.toMatchObject({ succeeded: [], failed: [{ id: parent.id }] });
    const destination = await createFolder(db(), { parentId: 'root', name: 'Destination' });
    await expect(moveEntries(db(), [child.id], destination.id)).resolves.toMatchObject({ succeeded: [child.id], failed: [] });
  });

  it('changes visibility for every valid selected entry', async () => {
    const one = await createFolder(db(), { parentId: 'root', name: 'One' });
    const two = await createFolder(db(), { parentId: 'root', name: 'Two' });
    const result = await setEntriesVisibility(db(), [one.id, two.id], false);
    expect(result.succeeded).toEqual([one.id, two.id]);
    expect((await getEntryById(db(), one.id))?.is_public).toBe(0);
  });
});
