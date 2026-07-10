import { describe, expect, it } from 'vitest';
import { buildLegacyEntries } from '../../scripts/lib/legacy-entries.mjs';

describe('legacy object migration', () => {
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
});
