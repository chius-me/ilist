import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/worker/types';

const db = () => (env as unknown as Env).DB;

describe('entries schema', () => {
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
});
