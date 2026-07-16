import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }));
    await waitFor(() => expect(location.pathname).toBe('/Docs'));
  });

  it('combines path navigation and file controls in command order', async () => {
    const reportRoot = {
      ...root,
      data: {
        ...root.data,
        items: [{
          ...root.data.items[1],
          id: 'report-file',
          name: 'report.pdf',
          contentType: 'application/pdf',
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify({ ok: true, data: { username: 'admin' } }));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(reportRoot));
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<App />);
    const path = await screen.findByRole('navigation', { name: 'Path' });
    const controls = screen.getByRole('region', { name: 'File controls' });
    const files = await screen.findByRole('list', { name: 'Files and folders' });
    const home = within(path).getByRole('button', { name: 'Path home' });
    const search = within(controls).getByRole('button', { name: 'Search this folder' });
    const sort = within(controls).getByRole('combobox', { name: 'Sort files' });
    const direction = within(controls).getByRole('button', { name: 'Sort ascending' });
    const refresh = within(controls).getByRole('button', { name: 'Refresh' });
    const list = within(controls).getByRole('button', { name: 'List view' });

    expect(controls).toContainElement(path);
    expect(home).not.toHaveTextContent('ilist');
    expect(path.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sort.compareDocumentPosition(direction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(direction.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(refresh.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const open = screen.getByRole('button', { name: 'Open report.pdf' });
    expect(open).not.toContainElement(screen.getByRole('button', { name: 'Actions for report.pdf' }));
  });

  it('opens search on demand and restores focus to its button on Escape', async () => {
    render(<App />);
    const search = await screen.findByRole('button', { name: 'Search this folder' });

    expect(screen.queryByRole('textbox', { name: 'Search this folder' })).not.toBeInTheDocument();
    fireEvent.click(search);

    const input = screen.getByRole('textbox', { name: 'Search this folder' });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Search this folder' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search this folder' })).toHaveFocus();
  });

  it('closes search when another command-bar control is used', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Search this folder' }));
    expect(screen.getByRole('textbox', { name: 'Search this folder' })).toBeVisible();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Sort files' }));

    expect(screen.queryByRole('textbox', { name: 'Search this folder' })).not.toBeInTheDocument();
  });

  it('refreshes the directory and disables refresh while loading', async () => {
    let listRequests = 0;
    let resolveRefresh: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(guestError), { status: 401 });
      if (url.includes('/api/fs/list')) {
        listRequests += 1;
        if (listRequests === 1) return new Response(JSON.stringify(root), { status: 200 });
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<App />);
    await screen.findByRole('list', { name: 'Files and folders' });
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(refresh);

    await waitFor(() => expect(listRequests).toBe(2));
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(listRequests).toBe(2);

    resolveRefresh!(new Response(JSON.stringify(root), { status: 200 }));
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it('persists view changes only in versioned preferences', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grid view' }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem('ilist.ui.preferences')!)).toMatchObject({ defaultView: 'grid' }));
    expect(localStorage.getItem('ilist.explorer.view')).toBeNull();
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
