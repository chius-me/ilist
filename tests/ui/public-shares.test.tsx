import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { SharePage } from '../../src/ui/app/SharePage';

const capabilities = (kind: 'file' | 'folder', download = false) => ({
  open: kind === 'folder', preview: kind === 'file', download, upload: false, multipartUpload: false,
  createFolder: false, rename: false, move: false, delete: false, changeVisibility: false,
});
const folder = { id: 'sealed-folder', parentId: null, name: 'Shared folder', kind: 'folder', size: 0, contentType: null, updatedAt: '2026-07-18T00:00:00Z', isPublic: false, effectivePublic: false, sortOrder: 0, description: '', mountPath: null, capabilities: capabilities('folder') };
const file = { id: 'sealed-file', parentId: null, name: 'private.txt', kind: 'file', size: 12, contentType: 'text/plain', updatedAt: '2026-07-18T00:00:00Z', isPublic: false, effectivePublic: false, sortOrder: 0, description: '', mountPath: null, capabilities: capabilities('file', false) };

describe('public share page', () => {
  it('unlocks a password-protected folder and navigates without admin controls', async () => {
    let authorized = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/s/public-token/api' && !authorized) return Response.json({ ok: false, error: { code: 'SHARE_PASSWORD_REQUIRED', message: 'required' } }, { status: 401 });
      if (url === '/s/public-token/auth' && init?.method === 'POST') { authorized = true; return Response.json({ ok: true, data: {} }); }
      if (url === '/s/public-token/api') return Response.json({ ok: true, data: { name: 'Shared folder', targetKind: 'folder', allowDownload: false, protected: true, expiresAt: null, entry: folder } });
      if (url === '/s/public-token/api/list') return Response.json({ ok: true, data: { current: folder, breadcrumbs: [], items: [file] } });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<AppProviders><SharePage token="public-token" /></AppProviders>);
    expect(await screen.findByRole('heading', { name: 'Protected share' })).toBeVisible();
    await userEvent.type(screen.getByLabelText('Password'), 'share-password');
    await userEvent.click(screen.getByRole('button', { name: 'Open share' }));
    expect(await screen.findByText('private.txt')).toBeVisible();
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('previews through the share URL and omits download controls when policy denies them', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/s/public-token/api') return Response.json({ ok: true, data: { name: 'private.txt', targetKind: 'file', allowDownload: false, protected: false, expiresAt: null, entry: file } });
      if (url.startsWith('/s/public-token/file/sealed-file/private.txt')) return new Response('private-data', { headers: { 'content-type': 'text/plain' } });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<AppProviders><SharePage token="public-token" /></AppProviders>);
    expect(await screen.findByRole('dialog', { name: 'Preview private.txt' })).toBeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/s/public-token/file/sealed-file/private.txt', expect.anything()));
    expect(screen.queryByRole('link', { name: /download private\.txt/i })).not.toBeInTheDocument();
  });

  it('navigates nested folders and returns to the share root breadcrumb', async () => {
    const nested = { ...folder, id: 'sealed-nested', name: 'Nested' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/s/public-token/api') return Response.json({ ok: true, data: { name: 'Shared folder', targetKind: 'folder', allowDownload: false, protected: false, expiresAt: null, entry: folder } });
      if (url === '/s/public-token/api/list') return Response.json({ ok: true, data: { current: folder, breadcrumbs: [], items: [nested] } });
      if (url.includes('parent=sealed-nested')) return Response.json({ ok: true, data: { current: nested, breadcrumbs: [], items: [file] } });
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<AppProviders><SharePage token="public-token" /></AppProviders>);
    await userEvent.click(await screen.findByRole('button', { name: 'Open Nested' }));
    expect(await screen.findByText('private.txt')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Shared folder' }));
    expect(await screen.findByText('Nested')).toBeVisible();
  });

  it('renders a dedicated unavailable state without leaking the Worker message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: { code: 'SHARE_DISABLED', message: 'internal policy details' } }, { status: 410 })));
    render(<AppProviders><SharePage token="public-token" /></AppProviders>);
    expect(await screen.findByRole('heading', { name: 'Share disabled' })).toBeVisible();
    expect(screen.queryByText('internal policy details')).not.toBeInTheDocument();
  });
});
