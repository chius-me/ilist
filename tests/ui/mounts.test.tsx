import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { MountManager } from '../../src/ui/features/mounts/MountManager';

const admin = { ok: true, data: { username: 'admin' } };
const emptyRoot = { ok: true, data: { current: { id: 'virtual-root', parentId: null, name: '', kind: 'folder', size: 0, contentType: null, updatedAt: '', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', mountPath: null, capabilities: { open: true, preview: false, download: false, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false } }, breadcrumbs: [], items: [] } };
const savedMount = {
  id: 'mount-1', name: 'Archive', mountPath: '/archive', driverType: 's3', provider: 'cloudflare-r2',
  enabled: true, isPublic: true, sortOrder: 0, rootItemId: null,
  config: { endpoint: 'https://account.r2.cloudflarestorage.com', region: 'auto', bucket: 'files', rootPrefix: '', addressingMode: 'path' },
  connected: true, createdAt: '2026-07-15T00:00:00Z', updatedAt: '2026-07-15T00:00:00Z',
};
const oneDriveMount = {
  ...savedMount, id: 'onedrive-1', name: 'Personal drive', mountPath: '/personal', driverType: 'onedrive',
  provider: 'microsoft-onedrive-personal', connected: false, config: {},
};

async function chooseAction(mountName: string, actionName: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${mountName}` }));
  await userEvent.click(screen.getByRole('button', { name: actionName }));
}

describe('MountManager', () => {
  beforeEach(() => history.replaceState(null, '', '/admin/storages'));

  it('lists mounts without exposing credentials and tests a connection', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return Response.json(admin);
      if (url.endsWith('/api/admin/mounts') && !init?.method) return Response.json({ ok: true, data: [savedMount] });
      if (url.endsWith('/api/admin/mounts/mount-1/test')) return Response.json({ ok: true, data: { connected: true } });
      if (url.includes('/api/fs/list')) return Response.json(emptyRoot);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Storage mounts' })).toBeVisible();
    expect(await screen.findByText('Archive')).toBeVisible();
    expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
    await chooseAction('Archive', 'Test connection');
    expect(await screen.findByText('Connection successful')).toBeVisible();
  });

  it('creates an R2 preset mount and sends entered credentials once', async () => {
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return Response.json(admin);
      if (url.endsWith('/api/admin/mounts') && !init?.method) return Response.json({ ok: true, data: [] });
      if (url.endsWith('/api/admin/mounts') && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body));
        return Response.json({ ok: true, data: savedMount }, { status: 201 });
      }
      if (url.includes('/api/fs/list')) return Response.json(emptyRoot);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add storage' }));
    await userEvent.type(screen.getByLabelText('Display name'), 'Archive');
    await userEvent.type(screen.getByLabelText('Mount path'), '/archive');
    await userEvent.type(screen.getByLabelText('Account ID'), 'account');
    await userEvent.type(screen.getByLabelText('Bucket'), 'files');
    await userEvent.type(screen.getByLabelText('Access Key ID'), 'access');
    await userEvent.type(screen.getByLabelText('Secret Access Key'), 'secret-value');
    await userEvent.click(screen.getByRole('button', { name: 'Create mount' }));

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({
      name: 'Archive', mountPath: '/archive', driverType: 's3', provider: 'cloudflare-r2',
      config: { endpoint: 'https://account.r2.cloudflarestorage.com', region: 'auto', bucket: 'files', addressingMode: 'path' },
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret-value' },
    });
  });

  it('edits metadata with blank secrets, toggles enabled state, and confirms deletion', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (url.includes('/api/admin/me')) return Response.json(admin);
      if (url.endsWith('/api/admin/mounts') && method === 'GET') return Response.json({ ok: true, data: [savedMount] });
      if (url.includes('/api/admin/mounts/mount-1') && (method === 'PATCH' || method === 'DELETE')) {
        requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ ok: true, data: { ...savedMount, enabled: false } });
      }
      if (url.includes('/api/fs/list')) return Response.json(emptyRoot);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<App />);
    await chooseAction('Archive', 'Edit');
    expect(screen.getByLabelText('Secret Access Key')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Cold archive' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await chooseAction('Archive', 'Disable');
    await chooseAction('Archive', 'Delete');
    expect(screen.getByRole('dialog', { name: 'Delete storage mount' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Delete mount' }));

    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
    const edit = requests.find((request) => request.method === 'PATCH' && (request.body as { name?: string }).name);
    expect(edit?.body).toMatchObject({ name: 'Cold archive' });
    expect(JSON.stringify(edit?.body)).not.toContain('secretAccessKey');
  });

  it('creates a named OneDrive mount before starting OAuth', async () => {
    const navigate = vi.fn();
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json({ ok: true, data: [] });
      submitted = JSON.parse(String(init.body));
      return Response.json({ ok: true, data: oneDriveMount });
    }));

    render(<AppProviders><MountManager onBack={vi.fn()} navigate={navigate} /></AppProviders>);
    await userEvent.click(await screen.findByRole('button', { name: 'Add storage' }));
    await userEvent.selectOptions(screen.getByLabelText('Storage type'), 'onedrive');
    await userEvent.type(screen.getByLabelText('Display name'), 'Personal drive');
    await userEvent.type(screen.getByLabelText('Mount path'), '/personal');
    await userEvent.click(screen.getByRole('button', { name: 'Create and connect' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/api/admin/oauth/onedrive/start?mountId=onedrive-1'));
    expect(submitted).toMatchObject({
      name: 'Personal drive', mountPath: '/personal', driverType: 'onedrive', provider: 'microsoft-onedrive-personal', config: {},
    });
  });

  it('shows connection state and confirms disconnecting OneDrive', async () => {
    const connected = { ...oneDriveMount, connected: true };
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return Response.json({ ok: true, data: [connected] });
      requests.push(`${init.method} ${url}`);
      return Response.json({ ok: true, data: { ...connected, connected: false } });
    }));

    render(<AppProviders><MountManager onBack={vi.fn()} navigate={vi.fn()} /></AppProviders>);
    expect(await screen.findByText('Connected')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Personal drive' }));
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByRole('dialog', { name: 'Disconnect OneDrive' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect account' }));
    await waitFor(() => expect(requests).toContain('POST /api/admin/mounts/onedrive-1/disconnect'));
  });

  it('focuses mount confirmations, closes on Escape, and restores the invoking action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: [savedMount] })));
    render(<AppProviders><MountManager onBack={vi.fn()} /></AppProviders>);
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Archive' }));
    const deleteAction = screen.getByRole('button', { name: 'Delete' });
    await userEvent.click(deleteAction);

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete storage mount' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Actions for Archive' })).toHaveFocus();
  });

  it('closes a mount action menu after selection and when another menu opens', async () => {
    const connected = { ...oneDriveMount, connected: true };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: [savedMount, connected] })));
    render(<AppProviders><MountManager onBack={vi.fn()} /></AppProviders>);

    const archiveTrigger = await screen.findByRole('button', { name: 'Actions for Archive' });
    const personalTrigger = screen.getByRole('button', { name: 'Actions for Personal drive' });
    await userEvent.click(archiveTrigger);
    expect(archiveTrigger.closest('details')).toHaveAttribute('open');

    await userEvent.click(personalTrigger);
    expect(archiveTrigger.closest('details')).not.toHaveAttribute('open');
    expect(personalTrigger.closest('details')).toHaveAttribute('open');

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(personalTrigger.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(personalTrigger).toHaveFocus();
  });

  it('shows a concise OneDrive callback failure status', async () => {
    history.replaceState(null, '', '/admin/storages?onedrive=error');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: [oneDriveMount] })));

    render(<AppProviders><MountManager onBack={vi.fn()} navigate={vi.fn()} /></AppProviders>);
    expect(await screen.findByText('OneDrive connection failed')).toBeVisible();
  });

  it('localizes mount API failures without exposing provider messages', async () => {
    localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale: 'zh-CN', theme: 'light', defaultView: 'list' }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Raw mount provider failure' } }, { status: 502 })));
    render(<AppProviders><MountManager onBack={vi.fn()} /></AppProviders>);
    expect(await screen.findByText('存储操作失败。')).toBeVisible();
    expect(screen.queryByText(/Raw mount/)).not.toBeInTheDocument();
  });
});
