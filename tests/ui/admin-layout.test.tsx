import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';

const admin = { ok: true, data: { username: 'admin' } };
const savedMount = {
  id: 'mount-1', name: 'Archive', mountPath: '/archive', driverType: 's3', provider: 'cloudflare-r2',
  enabled: true, isPublic: true, sortOrder: 0, rootItemId: null,
  config: { endpoint: 'https://account.r2.cloudflarestorage.com', region: 'auto', bucket: 'files', rootPrefix: '', addressingMode: 'path' },
  connected: true, createdAt: '2026-07-15T00:00:00Z', updatedAt: '2026-07-15T00:00:00Z',
};

describe('administration layout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return Response.json(admin);
      if (url.endsWith('/api/admin/mounts')) return Response.json({ ok: true, data: [savedMount] });
      if (url.includes('/api/admin/logout')) return Response.json({ ok: true, data: {} });
      if (url.includes('/api/fs/list')) return Response.json({ ok: true, data: { current: { id: 'root', parentId: null, name: '', kind: 'folder', size: 0, contentType: null, updatedAt: '', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', mountPath: null, capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false, upload: false, createFolder: false } }, breadcrumbs: [], items: [] } });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('navigates between storage, appearance, and files', async () => {
    history.replaceState(null, '', '/admin/storages');
    render(<App />);

    expect(await screen.findByRole('navigation', { name: 'Administration' })).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Appearance' }));
    expect(location.pathname).toBe('/admin/appearance');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Files' }));
    expect(location.pathname).toBe('/');
  });

  it('updates local preferences without an API request', async () => {
    history.replaceState(null, '', '/admin/appearance');
    render(<App />);

    await userEvent.selectOptions(await screen.findByLabelText('Language'), 'zh-CN');
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('settings'), expect.anything());
  });

  it('renders mounts as one semantic table', async () => {
    history.replaceState(null, '', '/admin/storages');
    render(<App />);

    const table = await screen.findByRole('table', { name: 'Storage mounts' });
    expect(within(table).getByText('/archive')).toBeVisible();
    expect(within(table).getByText('Cloudflare R2')).toBeVisible();
  });

  it('returns to the remembered public path after signing out from administration', async () => {
    history.replaceState(null, '', '/Projects');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Storage settings' }));
    expect(location.pathname).toBe('/admin/storages');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(location.pathname).toBe('/Projects'));
    expect(screen.queryByRole('dialog', { name: 'Admin sign in' })).not.toBeInTheDocument();
  });
});
