import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { matchesNameFilter } from '../../src/worker/entries';
import { copyEntries, createFolder, listVirtualDirectory, uploadFile } from '../../src/worker/file-system';
import type { Env } from '../../src/worker/types';

function workerEnv(): Env {
  return env as unknown as Env;
}

describe('directory name filter and same-mount copy', () => {
  it('matches names case-insensitively and requires a non-empty needle', () => {
    expect(matchesNameFilter('Reports', null)).toBe(true);
    expect(matchesNameFilter('Reports', '  ')).toBe(true);
    expect(matchesNameFilter('Reports', 'port')).toBe(true);
    expect(matchesNameFilter('Reports', 'PORT')).toBe(true);
    expect(matchesNameFilter('Reports', 'xyz')).toBe(false);
  });

  it('filters native-r2 listings server-side and copies files without overwrite', async () => {
    const db = workerEnv().DB;
    const alpha = await createFolder(db, { parentId: 'root', name: 'alpha-docs' });
    const beta = await createFolder(db, { parentId: 'root', name: 'beta-docs' });
    await createFolder(db, { parentId: 'root', name: 'notes' });

    const filtered = await listVirtualDirectory(workerEnv(), '/R2', true, 'docs');
    const names = filtered.items.map((item) => item.name).sort();
    expect(names).toEqual(['alpha-docs', 'beta-docs'].sort());

    const fileId = crypto.randomUUID();
    await uploadFile(workerEnv(), new Request('https://example.test/upload', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello-copy',
    }), { id: fileId, parentId: alpha.id, name: 'readme.txt' });

    const copied = await copyEntries(workerEnv(), [fileId], beta.id);
    expect(copied.succeeded).toEqual([fileId]);
    expect(copied.failed).toEqual([]);

    const conflict = await copyEntries(workerEnv(), [fileId], beta.id);
    expect(conflict.succeeded).toEqual([]);
    expect(conflict.failed).toEqual([
      expect.objectContaining({ id: fileId, code: 'ENTRY_NAME_CONFLICT' }),
    ]);
  });
});
