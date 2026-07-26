import { describe, expect, it, vi } from 'vitest';
import { directoryErrorHint, directoryErrorTitle } from '../../src/ui/lib/directory-errors';
import {
  DIRECTORY_QUERY_DEBOUNCE_MS,
  normalizeDirectoryQuery,
  shouldCommitDirectoryQuery,
} from '../../src/ui/lib/directory-query';
import { scheduleDeferredFeedback } from '../../src/ui/lib/deferred-feedback';
import { compareEntries, sortEntries, type ExplorerSort } from '../../src/ui/lib/explorer-sort';
import {
  emptySelection,
  rangeSelection,
  replaceSelection,
  selectAllSelection,
  toggleSelection,
} from '../../src/ui/lib/selection-state';
import { ApiError } from '../../src/ui/api/client';
import type { Entry } from '../../src/ui/types/entries';

const caps = {
  open: false,
  preview: true,
  download: true,
  upload: false,
  createFolder: false,
  rename: true,
  move: true,
  copy: false,
  delete: true,
  changeVisibility: true,
};

function entry(partial: Partial<Entry> & Pick<Entry, 'id' | 'name' | 'kind'>): Entry {
  return {
    parentId: 'root',
    size: 0,
    contentType: null,
    updatedAt: '2026-07-10T00:00:00Z',
    isPublic: true,
    effectivePublic: true,
    sortOrder: 0,
    description: '',
    mountPath: null,
    capabilities: caps,
    ...partial,
  };
}

const t = ((key: string) => key) as ReturnType<typeof import('../../src/ui/i18n/I18nProvider').useI18n>['t'];

describe('explorer-sort (shipped)', () => {
  it('orders folders before files then applies field sort', () => {
    const items = [
      entry({ id: 'b', name: 'beta.txt', kind: 'file', size: 20 }),
      entry({ id: 'a', name: 'alpha', kind: 'folder' }),
      entry({ id: 'c', name: 'gamma.txt', kind: 'file', size: 5 }),
    ];
    const sort: ExplorerSort = { field: 'size', order: 'asc' };
    const sorted = sortEntries(items, sort);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(compareEntries(items[0], items[2], sort)).toBeGreaterThan(0);
  });
});

describe('directory-query (shipped)', () => {
  it('normalizes and commits only on change', () => {
    expect(DIRECTORY_QUERY_DEBOUNCE_MS).toBe(200);
    expect(normalizeDirectoryQuery('  docs  ')).toBe('docs');
    expect(shouldCommitDirectoryQuery(' docs ', 'docs')).toEqual({ commit: false, next: 'docs' });
    expect(shouldCommitDirectoryQuery(' notes ', 'docs')).toEqual({ commit: true, next: 'notes' });
  });
});

describe('selection-state (shipped)', () => {
  it('toggles, ranges, replaces, and selects all without mutating prior sets', () => {
    const start = emptySelection();
    const one = toggleSelection(start, 'a');
    expect([...one.selectedIds]).toEqual(['a']);
    expect(start.selectedIds.size).toBe(0);

    const two = toggleSelection(one, 'c');
    const ranged = rangeSelection(two, ['a', 'b', 'c', 'd'], 'b');
    expect([...ranged.selectedIds].sort()).toEqual(['a', 'b', 'c']);

    const all = selectAllSelection(ranged, ['a', 'b', 'c', 'd']);
    expect(all.selectedIds.size).toBe(4);

    const replaced = replaceSelection(['x']);
    expect([...replaced.selectedIds]).toEqual(['x']);
    expect(replaced.anchorId).toBe('x');
  });
});

describe('directory-errors (shipped)', () => {
  it('maps mount and not-found API errors to product copy keys', () => {
    const disabled = new ApiError(503, 'MOUNT_DISABLED', 'disabled');
    expect(directoryErrorTitle(disabled, t)).toBe('state.disconnected');
    expect(directoryErrorHint(disabled, t)).toBe('state.disconnectedHint');

    const missing = new ApiError(404, 'ENTRY_NOT_FOUND', 'missing');
    expect(directoryErrorTitle(missing, t)).toBe('state.unavailable');
    expect(directoryErrorHint(missing, t)).toBe('state.unavailableHint');
  });
});

describe('deferred-feedback (shipped)', () => {
  it('runs the callback on a microtask after the current stack', async () => {
    const order: string[] = [];
    scheduleDeferredFeedback(() => { order.push('deferred'); });
    order.push('sync');
    await Promise.resolve();
    expect(order).toEqual(['sync', 'deferred']);
  });
});
