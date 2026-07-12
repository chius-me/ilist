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
      capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false },
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
        capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false },
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
        capabilities: { open: false, preview: true, download: true, rename: false, move: false, delete: false, changeVisibility: false },
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
});
