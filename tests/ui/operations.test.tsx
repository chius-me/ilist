import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { FolderPickerDialog } from '../../src/ui/features/operations/FolderPickerDialog';

const entry = (id: string, name: string, kind: 'file' | 'folder') => ({
  id, parentId: 'root', name, kind, size: kind === 'file' ? 2400 : 0,
  contentType: kind === 'file' ? 'application/pdf' : null,
  updatedAt: '2026-07-10T00:00:00Z', isPublic: true, effectivePublic: true,
  sortOrder: 0, description: '', mountPath: null,
  capabilities: { open: kind === 'folder', preview: kind === 'file', download: kind === 'file', upload: kind === 'folder', createFolder: kind === 'folder', rename: true, move: true, delete: true, changeVisibility: true },
});

const root = {
  ok: true,
  data: {
    current: { ...entry('root', '', 'folder'), parentId: null, capabilities: { open: true, preview: false, download: false, upload: true, createFolder: true, rename: false, move: false, delete: false, changeVisibility: false } },
    breadcrumbs: [{ id: 'root', name: 'ilist', path: '/' }],
    items: [entry('report', 'report.pdf', 'file'), entry('archive', 'Archive', 'folder')],
  },
};

describe('explorer operations', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify({ ok: true, data: { username: 'admin' } }));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(root));
      if (url.includes('/api/admin/entries/visibility')) return new Response(JSON.stringify({ ok: true, data: { succeeded: ['report'], failed: [] } }));
      if (url.includes('/api/admin/entries/report')) return Response.json({ ok: true, data: entry('report', 'renamed.pdf', 'file') });
      if (url.includes('/api/admin/folders')) return Response.json({ ok: true, data: entry('folder-new', 'New folder', 'folder') });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('switches to a selection toolbar and submits a batch visibility change', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select report.pdf' }));
    expect(screen.getByText('1 selected')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Hide selected' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/admin/entries/visibility',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('uses an application dialog instead of window.confirm for delete', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for report.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete report.pdf' })).toBeVisible();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('announces successful rename, folder creation, and property updates', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for report.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed.pdf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Renamed successfully.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New folder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Folder created.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for report.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Properties saved.')).toBeVisible();
  });

  it('announces clipboard failures', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for report.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(await screen.findByText('Unable to copy the link.')).toBeVisible();
  });

  it('keeps the virtual root read-only for administrators', async () => {
    const virtualRoot = {
      ...root,
      data: {
        current: {
          ...root.data.current,
          id: 'virtual-root',
          mountPath: null,
          capabilities: {
            open: true,
            preview: false,
            download: false,
            rename: false,
            move: false,
            delete: false,
            changeVisibility: false,
            upload: false,
            createFolder: false,
          },
        },
        breadcrumbs: [{ id: 'virtual-root', name: 'ilist', path: '/' }],
        items: [{
          ...entry('archive-mount', 'Cold Storage', 'folder'),
          mountPath: '/archive',
          capabilities: {
            open: true,
            preview: false,
            download: false,
            rename: false,
            move: false,
            delete: false,
            changeVisibility: false,
            upload: false,
            createFolder: false,
          },
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify({ ok: true, data: { username: 'admin' } }));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(virtualRoot));
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<App />);
    expect(await screen.findByText('Cold Storage')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Upload files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create folder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Cold Storage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selected file actions' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.queryByRole('checkbox', { name: 'Select Cold Storage' })).not.toBeInTheDocument();
  });

  it('uses mount paths in the folder picker and names for mounted children', async () => {
    const selected = entry('report', 'report.pdf', 'file');
    const mountRoot = {
      ...root,
      data: {
        ...root.data,
        items: [{ ...entry('archive-mount', 'Cold Storage', 'folder'), mountPath: '/archive' }],
      },
    };
    const archive = {
      ...root,
      data: {
        ...root.data,
        current: { ...root.data.current, id: 'archive-root', mountPath: '/archive' },
        items: [{ ...entry('reports', 'Reports', 'folder'), mountPath: '/archive' }],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('path=%2Farchive%2FReports')) return new Response(JSON.stringify(archive));
      if (url.includes('path=%2Farchive')) return new Response(JSON.stringify(archive));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(mountRoot));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FolderPickerDialog entries={[selected]} onClose={() => undefined} onSubmit={async () => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /Cold Storage/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/fs/list?path=%2Farchive',
      expect.objectContaining({ credentials: 'same-origin' }),
    ));
    fireEvent.click(await screen.findByRole('button', { name: /Reports/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/fs/list?path=%2Farchive%2FReports',
      expect.objectContaining({ credentials: 'same-origin' }),
    ));
  });

  it('disables the virtual root as a move destination and enables a writable mount', async () => {
    const selected = entry('report', 'report.pdf', 'file');
    const readOnlyCapabilities = {
      open: true,
      preview: false,
      download: false,
      rename: false,
      move: false,
      delete: false,
      changeVisibility: false,
      upload: false,
      createFolder: false,
    };
    const virtualRoot = {
      ...root,
      data: {
        current: {
          ...root.data.current,
          id: 'virtual-root',
          mountPath: null,
          capabilities: readOnlyCapabilities,
        },
        breadcrumbs: [{ id: 'virtual-root', name: 'ilist', path: '/' }],
        items: [{
          ...entry('archive-mount', 'Cold Storage', 'folder'),
          mountPath: '/archive',
          capabilities: readOnlyCapabilities,
        }],
      },
    };
    const archive = {
      ...root,
      data: {
        current: {
          ...root.data.current,
          id: 'archive-root',
          mountPath: '/archive',
          capabilities: {
            ...readOnlyCapabilities,
            upload: true,
            createFolder: true,
          },
        },
        breadcrumbs: [
          { id: 'virtual-root', name: 'ilist', path: '/' },
          { id: 'archive-root', name: 'Cold Storage', path: '/archive' },
        ],
        items: [],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('path=%2Farchive')) return new Response(JSON.stringify(archive));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(virtualRoot));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', fetchMock);

    render(<FolderPickerDialog entries={[selected]} onClose={onClose} onSubmit={onSubmit} />);
    const moveHere = await screen.findByRole('button', { name: 'Move here' });
    expect(moveHere).toBeDisabled();
    fireEvent.click(moveHere);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Cold Storage/ }));
    await waitFor(() => expect(moveHere).toBeEnabled());
    fireEvent.click(moveHere);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('archive-root'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
