import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { SharePage } from '../../src/ui/app/SharePage';
import { AppHeader } from '../../src/ui/components/AppHeader';
import { entryActions } from '../../src/ui/features/explorer/EntryActionMenu';
import { ExplorerToolbar } from '../../src/ui/features/explorer/ExplorerToolbar';
import { FileList } from '../../src/ui/features/explorer/FileList';
import { ShareManager } from '../../src/ui/features/shares/ShareManager';
import { computeVirtualWindow } from '../../src/ui/hooks/useVirtualWindow';
import { DirectoryCache } from '../../src/ui/lib/directory-cache';
import { enqueueFolderUpload } from '../../src/ui/lib/folder-upload';
import type { Entry } from '../../src/ui/types/entries';

const capabilities = {
  open: true,
  preview: true,
  download: true,
  upload: true,
  multipartUpload: false,
  createFolder: true,
  rename: true,
  move: true,
  copy: true,
  delete: true,
  changeVisibility: true,
};

function makeEntry(id: string, name: string, kind: 'file' | 'folder' = 'file', size = 100): Entry {
  return {
    id,
    parentId: 'root',
    name,
    kind,
    size,
    contentType: kind === 'folder' ? null : 'text/plain',
    updatedAt: '2026-07-15T00:00:00Z',
    isPublic: true,
    effectivePublic: true,
    sortOrder: 0,
    description: '',
    mountPath: null,
    capabilities,
  };
}

describe('Milestone 4 features', () => {
  it('enqueues folder uploads recursively, creating nested folders and reusing existing roots', async () => {
    const created: Array<{ parentId: string; name: string }> = [];
    const queued: Array<{ parentId: string; names: string[] }> = [];
    let seq = 0;

    const existingDocs = makeEntry('folder-docs', 'docs', 'folder', 0);
    const a = new File(['hello'], 'readme.md', { type: 'text/markdown' });
    const b = new File(['spec'], 'spec.txt', { type: 'text/plain' });
    const c = new File(['root'], 'top.txt', { type: 'text/plain' });

    const outcome = await enqueueFolderUpload(
      [
        { file: a, relativePath: 'docs/sub/readme.md' },
        { file: b, relativePath: 'docs/sub/spec.txt' },
        { file: c, relativePath: 'newdir/top.txt' },
      ],
      'root-id',
      {
        existingEntries: [existingDocs],
        createFolder: async (parentId, name) => {
          created.push({ parentId, name });
          seq += 1;
          return makeEntry(`created-${seq}`, name, 'folder', 0);
        },
        enqueueFiles: (parentId, files) => {
          queued.push({ parentId, names: files.map((file) => file.name) });
        },
      },
    );

    expect(outcome).toEqual({ foldersCreated: 2, filesQueued: 3 });
    expect(created).toEqual([
      { parentId: 'root-id', name: 'newdir' },
      { parentId: 'folder-docs', name: 'sub' },
    ]);
    expect(queued).toEqual([
      { parentId: 'created-2', names: ['readme.md', 'spec.txt'] },
      { parentId: 'created-1', names: ['top.txt'] },
    ]);
  });

  it('evicts DirectoryCache entries on LRU capacity and TTL expiration', () => {
    let now = 1_000;
    const cache = new DirectoryCache<string>(2, 30_000, () => now);
    cache.set('admin:/a', 'A');
    cache.set('admin:/b', 'B');
    expect(cache.get('admin:/a')).toBe('A'); // Refresh /a recency; /b is oldest.
    cache.set('admin:/c', 'C');
    expect(cache.get('admin:/b')).toBeNull();
    expect(cache.get('admin:/a')).toBe('A');
    expect(cache.get('admin:/c')).toBe('C');

    now += 31_000;
    expect(cache.get('admin:/a')).toBeNull();
  });

  it('computes non-virtualized range at <= 100 items and virtualized range at > 100 items', () => {
    expect(computeVirtualWindow({ count: 100, itemHeight: 36, scrollTop: 360, viewportHeight: 500 })).toEqual({
      virtualized: false,
      startIndex: 0,
      endIndex: 100,
      paddingTop: 0,
      paddingBottom: 0,
    });

    const large = computeVirtualWindow({ count: 250, itemHeight: 36, scrollTop: 720, viewportHeight: 360 });
    expect(large.virtualized).toBe(true);
    expect(large.startIndex).toBe(14);
    expect(large.endIndex).toBe(36);
    expect(large.paddingTop).toBe(14 * 36);
    expect(large.paddingBottom).toBe((250 - 36) * 36);
  });

  it('supports interactive column sort headers, indeterminate Select-All, single file input, and copy toast callback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onSort = vi.fn();
    const onToggleSelectAll = vi.fn();
    const onCopySuccess = vi.fn();

    const entries = [makeEntry('1', 'alpha.txt', 'file', 10), makeEntry('2', 'beta.txt', 'file', 20)];
    const { container } = render(
      <AppProviders>
        <ExplorerToolbar
          breadcrumbs={[{ id: 'root', name: 'iList', path: '/' }]}
          query=""
          sort={{ field: 'name', order: 'asc' }}
          view="list"
          refreshing={false}
          sessionStatus="admin"
          selectionCount={1}
          canUpload
          canCreateFolder
          onQuery={vi.fn()}
          onOpenPath={vi.fn()}
          onRefresh={vi.fn()}
          onSort={onSort}
          onView={vi.fn()}
          onUpload={vi.fn()}
          onUploadFolder={vi.fn()}
          onCreateFolder={vi.fn()}
        />
        <FileList
          entries={entries}
          selectedIds={new Set(['1'])}
          admin
          handlers={{ onOpen: vi.fn(), onPreview: vi.fn(), onToggle: vi.fn(), onMenu: vi.fn() }}
          sort={{ field: 'name', order: 'asc' }}
          onSort={onSort}
          allSelected={false}
          someSelected
          onToggleSelectAll={onToggleSelectAll}
        />
      </AppProviders>,
    );

    // Playwright relies on a single file input in rendered DOM even with folder upload enabled.
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Upload folder' })).toBeVisible();

    const selectAll = screen.getByRole('checkbox', { name: 'Select all entries' }) as HTMLInputElement;
    expect(selectAll.indeterminate).toBe(true);
    fireEvent.click(selectAll);
    expect(onToggleSelectAll).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenCalledWith({ field: 'name', order: 'desc' });
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(onSort).toHaveBeenCalledWith({ field: 'size', order: 'asc' });

    const actions = entryActions(entries[0]!, {
      onOpen: vi.fn(),
      onPreview: vi.fn(),
      onAction: vi.fn(),
      onCopySuccess,
    });
    actions.find((action) => action.id === 'copy')!.onSelect();
    await waitFor(() => expect(onCopySuccess).toHaveBeenCalledOnce());
  });

  it('filters and sorts SharePage items and displays ShareManager view/download stats', async () => {
    window.history.replaceState(null, '', '/s/token-demo');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/s/token-demo/api') {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            name: 'Public pack',
            targetKind: 'folder',
            allowDownload: true,
            protected: false,
            expiresAt: null,
            entry: makeEntry('share-root', 'Public pack', 'folder', 0),
          },
        }));
      }
      if (url.startsWith('/s/token-demo/api/list')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            current: makeEntry('share-root', 'Public pack', 'folder', 0),
            breadcrumbs: [],
            items: [makeEntry('s1', 'zeta.txt', 'file', 30), makeEntry('s2', 'alpha.txt', 'file', 10)],
          },
        }));
      }
      if (url === '/api/admin/shares') {
        return new Response(JSON.stringify({
          ok: true,
          data: [{
            id: 'sh-1',
            mountId: 'm1',
            mountName: 'Main',
            name: 'Release.zip',
            targetKind: 'file',
            protected: false,
            expiresAt: null,
            allowDownload: true,
            enabled: true,
            accessCount: 19,
            downloadCount: 4,
            maxDownloads: 10,
            createdAt: '2026-07-01T00:00:00Z',
            updatedAt: '2026-07-01T00:00:00Z',
          }],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(
      <AppProviders>
        <SharePage token="token-demo" />
        <ShareManager />
      </AppProviders>,
    );

    expect(await screen.findByText('19 views · 4 / 10')).toBeVisible();

    const searchInput = await screen.findByRole('textbox', { name: 'Search files' });
    fireEvent.change(searchInput, { target: { value: 'zeta' } });
    expect(screen.getByRole('button', { name: 'Open zeta.txt' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open alpha.txt' })).not.toBeInTheDocument();
  });

  it('uses VITE_REPO_URL and VITE_CONTACT_EMAIL overrides in AppHeader', () => {
    vi.stubEnv('VITE_REPO_URL', 'https://example.com/custom-repo');
    vi.stubEnv('VITE_CONTACT_EMAIL', 'support@example.com');

    render(
      <AppProviders>
        <AppHeader
          admin={false}
          showSessionActions={false}
          onHome={vi.fn()}
          onStorage={vi.fn()}
          onSignIn={vi.fn()}
          onSignOut={vi.fn()}
        />
      </AppProviders>,
    );

    expect(screen.getByRole('link', { name: 'Open iList on GitHub' })).toHaveAttribute('href', 'https://example.com/custom-repo');
    expect(screen.getByRole('link', { name: 'Email support@example.com' })).toHaveAttribute('href', 'mailto:support@example.com');
    vi.unstubAllEnvs();
  });
});
