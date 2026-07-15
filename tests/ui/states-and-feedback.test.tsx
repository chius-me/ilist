import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { LoginDialog } from '../../src/ui/features/explorer/LoginDialog';
import { PreviewOverlay } from '../../src/ui/features/preview/PreviewOverlay';
import type { Entry } from '../../src/ui/types/entries';

const capabilities = {
  open: false,
  preview: true,
  download: true,
  upload: false,
  createFolder: false,
  rename: true,
  move: true,
  delete: true,
  changeVisibility: true,
};

const entry = (id: string, name: string): Entry => ({
  id,
  parentId: 'root',
  name,
  kind: 'file',
  size: 2400,
  contentType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
  updatedAt: '2026-07-10T00:00:00Z',
  isPublic: true,
  effectivePublic: true,
  sortOrder: 0,
  description: '',
  mountPath: null,
  capabilities,
});

const report = entry('file-report', 'report.pdf');
const root = {
  ok: true,
  data: {
    current: {
      ...report,
      id: 'root',
      parentId: null,
      name: '',
      kind: 'folder' as const,
      size: 0,
      contentType: null,
      capabilities: { ...capabilities, open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false },
    },
    breadcrumbs: [{ id: 'root', name: 'ilist', path: '/' }],
    items: [report, entry('first', 'first.txt'), entry('second', 'second.txt')],
  },
};

const admin = { ok: true, data: { username: 'admin' } };

describe('page states and feedback', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
  });

  it('keeps stale content visible during refresh', async () => {
    let resolveRefresh!: (response: Response) => void;
    let listCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(admin));
      if (url.includes('/api/fs/list')) {
        listCalls += 1;
        if (listCalls === 1) return new Response(JSON.stringify(root));
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('report.pdf')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByText('report.pdf')).toBeVisible();
    expect(screen.getByRole('status', { name: 'Refreshing' })).toBeVisible();
    resolveRefresh(new Response(JSON.stringify(root)));
  });

  it('keeps failed batch entries selected and announces counts in the toast region', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(admin));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(root));
      if (url.includes('/api/admin/entries/visibility')) return new Response(JSON.stringify({
        ok: true,
        data: { succeeded: ['first'], failed: [{ id: 'second', code: 'STORAGE_OPERATION_FAILED', message: 'Storage failed' }] },
      }));
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('checkbox', { name: 'Select first.txt' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select second.txt' }));

    await user.click(screen.getByRole('button', { name: 'Hide selected' }));

    const notifications = await screen.findByRole('region', { name: 'Notifications' });
    expect(notifications).toHaveTextContent('1 completed, 1 failed');
    expect(screen.getByRole('checkbox', { name: 'Select second.txt' })).toBeChecked();
  });

  it('offers download after preview failure', () => {
    render(<AppProviders><PreviewOverlay entry={report} error={new Error('Preview failed')} onClose={() => undefined} /></AppProviders>);
    expect(screen.getByRole('alert')).toHaveTextContent('Preview failed');
    expect(screen.getByRole('link', { name: 'Download report.pdf' })).toBeVisible();
  });

  it('preserves the login username after failure and resets after close', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(<AppProviders><LoginDialog open busy={false} error={null} onClose={() => undefined} onSubmit={onSubmit} /></AppProviders>);
    await user.type(screen.getByLabelText('Username'), 'admin-user');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    rerender(<AppProviders><LoginDialog open busy={false} error="Invalid credentials" onClose={() => undefined} onSubmit={onSubmit} /></AppProviders>);
    expect(screen.getByLabelText('Username')).toHaveValue('admin-user');
    expect(screen.getByLabelText('Password')).toHaveValue('wrong-password');

    rerender(<AppProviders><LoginDialog open={false} busy={false} error={null} onClose={() => undefined} onSubmit={onSubmit} /></AppProviders>);
    rerender(<AppProviders><LoginDialog open busy={false} error={null} onClose={() => undefined} onSubmit={onSubmit} /></AppProviders>);
    await waitFor(() => expect(screen.getByLabelText('Username')).toHaveValue(''));
  });

  it('traps dialog focus and isolates the background while open', async () => {
    const user = userEvent.setup();
    render(<div><button type="button">Background command</button><AppProviders><LoginDialog open busy={false} error={null} onClose={() => undefined} onSubmit={() => undefined} /></AppProviders></div>);
    const dialog = screen.getByRole('dialog', { name: 'Admin sign in' });
    const username = screen.getByLabelText('Username');
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(dialog.parentElement).toHaveAttribute('data-modal-active', 'true');
    expect(screen.getByText('Background command').closest('button')).toHaveAttribute('inert');

    username.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    submit.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('distinguishes disconnected storage and offers one retry command', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify(admin));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify({ ok: false, error: { code: 'MOUNT_DISABLED', message: 'Mount is disabled' } }), { status: 403 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<App />);

    expect(await screen.findByText('Storage is disconnected')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('localizes directory and login API failures without exposing server messages', async () => {
    localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale: 'zh-CN', theme: 'light', defaultView: 'list' }));
    history.replaceState(null, '', '/raw-error');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return Response.json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Raw auth failure' } }, { status: 401 });
      if (url.includes('/api/fs/list')) return Response.json({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Raw provider failure' } }, { status: 502 });
      if (url.includes('/api/admin/login')) return Response.json({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Raw login failure' } }, { status: 401 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<App />);
    expect(await screen.findByText('存储操作失败。')).toBeVisible();
    expect(screen.queryByText(/Raw provider/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '管理员登录' }));
    await userEvent.type(screen.getByLabelText('用户名'), 'admin');
    await userEvent.type(screen.getByLabelText('密码'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('用户名或密码无效。')).toBeVisible();
    expect(screen.queryByText(/Raw login/)).not.toBeInTheDocument();
  });

  it('localizes a real preview metadata API failure before rendering it', async () => {
    localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale: 'zh-CN', theme: 'light', defaultView: 'list' }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return Response.json(admin);
      if (url.includes('/api/fs/list')) return Response.json(root);
      if (url.includes('/api/fs/entries/file-report')) return Response.json({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Raw preview metadata failure' } }, { status: 502 });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: '打开 report.pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('存储操作失败。');
    expect(screen.queryByText(/Raw preview metadata/)).not.toBeInTheDocument();
  });
});
