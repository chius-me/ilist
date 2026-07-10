import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;
const now = '2026-07-10T00:00:00.000Z';

async function insertFolder(id: string, parentId: string, name = id): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO entries (id, parent_id, name, kind, storage_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'folder', NULL, 'ready', ?, ?)`,
    )
    .bind(id, parentId, name, now, now)
    .run();
}

async function insertFile(id: string, parentId: string, name = id): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO entries (id, parent_id, name, kind, storage_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'file', ?, 'ready', ?, ?)`,
    )
    .bind(id, parentId, name, `blobs/${id}`, now, now)
    .run();
}

describe('entries schema', () => {
  beforeEach(async () => {
    await db().prepare("DELETE FROM entries WHERE id <> 'root'").run();
  });

  it('rejects non-root entries without a parent', async () => {
    await expect(
      db()
        .prepare(
          `INSERT INTO entries (id, parent_id, name, kind, storage_key, status, created_at, updated_at)
           VALUES ('orphan', NULL, 'orphan', 'folder', NULL, 'ready', 'now', 'now')`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it('rejects mutations that change canonical root invariants', async () => {
    await expect(db().prepare("UPDATE entries SET name = 'renamed' WHERE id = 'root'").run()).rejects.toThrow();
    await expect(db().prepare("UPDATE entries SET kind = 'file' WHERE id = 'root'").run()).rejects.toThrow();
  });

  it('rejects deletion of the canonical root', async () => {
    await expect(db().prepare("DELETE FROM entries WHERE id = 'root'").run()).rejects.toThrow();
  });

  it('rejects inserting a child beneath a file', async () => {
    await insertFile('file-parent', 'root');

    await expect(insertFolder('nested-folder', 'file-parent')).rejects.toThrow('parent entry must be a folder');
  });

  it('rejects moving an entry beneath a file', async () => {
    await insertFile('file-parent', 'root');
    await insertFolder('movable', 'root');

    await expect(db().prepare("UPDATE entries SET parent_id = 'file-parent' WHERE id = 'movable'").run()).rejects.toThrow(
      'parent entry must be a folder',
    );
  });

  it('rejects converting a non-empty folder to a file', async () => {
    await insertFolder('non-empty', 'root');
    await insertFolder('child', 'non-empty');

    await expect(
      db().prepare("UPDATE entries SET kind = 'file', storage_key = 'blobs/non-empty' WHERE id = 'non-empty'").run(),
    ).rejects.toThrow('cannot convert non-empty folder to file');
  });

  it('rejects a self-parenting insert', async () => {
    await expect(insertFolder('self-insert', 'self-insert')).rejects.toThrow('entry cannot be its own parent');
  });

  it('rejects a self-parenting update', async () => {
    await insertFolder('self-update', 'root');

    await expect(db().prepare("UPDATE entries SET parent_id = 'self-update' WHERE id = 'self-update'").run()).rejects.toThrow(
      'entry cannot be its own parent',
    );
  });

  it('rejects moving a folder beneath one of its descendants', async () => {
    await insertFolder('parent', 'root');
    await insertFolder('child', 'parent');

    await expect(db().prepare("UPDATE entries SET parent_id = 'child' WHERE id = 'parent'").run()).rejects.toThrow(
      'entry cannot be moved beneath a descendant',
    );
  });

  it('permits normal folder and file operations', async () => {
    await insertFolder('source', 'root');
    await insertFolder('child', 'source');
    await insertFolder('destination', 'root');
    await insertFile('document', 'source');

    await db().prepare("UPDATE entries SET name = 'renamed-document' WHERE id = 'document'").run();
    await db().prepare("UPDATE entries SET parent_id = 'destination' WHERE id = 'source'").run();
    await db().prepare("UPDATE entries SET kind = 'file', storage_key = 'blobs/child' WHERE id = 'child'").run();

    await expect(db().prepare("SELECT id, parent_id, name, kind FROM entries WHERE id IN ('source', 'child', 'document') ORDER BY id").all()).resolves.toMatchObject({
      results: [
        { id: 'child', parent_id: 'source', kind: 'file' },
        { id: 'document', parent_id: 'source', name: 'renamed-document', kind: 'file' },
        { id: 'source', parent_id: 'destination', kind: 'folder' },
      ],
    });
  });

  it('rejects changing the canonical root id even when parent_id changes too', async () => {
    await expect(
      db().prepare("UPDATE entries SET id = 'replacement-root', parent_id = 'replacement-root' WHERE id = 'root'").run(),
    ).rejects.toThrow('cannot change canonical root id');
  });
});
