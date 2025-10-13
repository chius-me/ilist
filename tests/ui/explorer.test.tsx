import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';

const guestError = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } };
const root = {
  ok: true,
  data: {
    current: {
      id: 'root',
      parentId: null,
      name: '',
      kind: 'folder',
      size: 0,
      contentType: null,
      updatedAt: '2026-07-10T00:00:00Z',
      isPublic: true,
      effectivePublic: true,
      sortOrder: 0,
      description: '',
      mountPath: null,
      capabilities: { open: true, preview: false, download: false, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false },
    },
    breadcrumbs: [{ id: 'root', name: 'ilist', path: '/' }],
    items: [
      {
        id: 'docs',
        parentId: 'root',
        name: 'Docs',
        kind: 'folder',
        size: 0,
        contentType: null,
        updatedAt: '2026-07-10T00:00:00Z',
        isPublic: true,
        effectivePublic: true,
        sortOrder: 0,
        description: '',
        mountPath: null,
        capabilities: { open: true, preview: false, download: false, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false },
      },
      {
        id: 'readme-file',
        parentId: 'root',
        name: 'README.txt',
        kind: 'file',
        size: 12,
        contentType: 'text/plain',
        updatedAt: '2026-07-10T00:00:00Z',
        isPublic: true,
        effectivePublic: true,
        sortOrder: 0,
        description: '',
        mountPath: null,
        capabilities: { open: false, preview: true, download: true, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false },
      },
    ],
  },
};

describe('ExplorerApp', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(guestError), { status: 401 });
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(root), { status: 200 });
      if (url.includes('/api/fs/entries/readme-file')) return new Response(JSON.stringify({ ok: true, data: root.data.items[1] }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('makes the file surface primary and follows folder/file click rules', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: /Docs/ })).toBeVisible();
    expect(screen.queryByText('listed size')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /README.txt/ }));
    expect(new URL(location.href).searchParams.get('preview')).toBe('readme-file');
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }));
    await waitFor(() => expect(location.pathname).toBe('/Docs'));
  });

  it('uses a root mount path for navigation and child names below the mount', async () => {
    const mountRoot = {
      ...root,
      data: {
        ...root.data,
        current: { ...root.data.current, id: 'virtual-root', mountPath: null },
        breadcrumbs: [{ id: 'virtual-root', name: 'ilist', path: '/' }],
        items: [{
          ...root.data.items[0],
          id: 'archive-mount',
          name: 'Cold Storage',
          mountPath: '/archive',
          mountId: 'archive-mount',
        }],
      },
    };
    const archive = {
      ...root,
      data: {
        ...root.data,
        current: { ...root.data.current, id: 'archive-root', mountPath: '/archive' },
        breadcrumbs: [
          { id: 'virtual-root', name: 'ilist', path: '/' },
          { id: 'archive-mount', name: 'Cold Storage', path: '/archive' },
        ],
        items: [{ ...root.data.items[0], id: 'reports', name: 'Reports', mountPath: '/archive' }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(guestError), { status: 401 });
      if (url.includes('path=%2Farchive')) return new Response(JSON.stringify(archive));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(mountRoot));
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Cold Storage/ }));
    await waitFor(() => expect(location.pathname).toBe('/archive'));
    fireEvent.click(await screen.findByRole('button', { name: /Reports/ }));
    await waitFor(() => expect(location.pathname).toBe('/archive/Reports'));
  });
});
