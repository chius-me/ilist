import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';

beforeEach(() => {
  history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/admin/me')) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
      }), { status: 401 });
    }
    if (url.includes('/api/fs/list')) {
      return new Response(JSON.stringify({
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
            capabilities: {
              open: true,
              preview: false,
              download: false,
              upload: false,
              createFolder: false,
              rename: false,
              move: false,
              delete: false,
              changeVisibility: false,
            },
          },
          breadcrumbs: [{ id: 'root', name: 'ilist', path: '/' }],
          items: [],
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
});

it('renders stable language, theme, and account controls', async () => {
  render(<App />);
  expect(await screen.findByRole('banner')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Open ilist root' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Change language' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Change theme' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Admin sign in' })).toBeVisible();
});

it('inverts the resolved system-dark theme on the first click', async () => {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  render(<App />);
  await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));
  fireEvent.click(screen.getByRole('button', { name: 'Change theme' }));
  await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
});

it('localizes shell controls after changing language', async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change language' }));

  expect(await screen.findByRole('link', { name: '跳转到内容' })).toBeVisible();
  expect(screen.getByRole('button', { name: '打开 ilist 根目录' })).toBeVisible();
  expect(screen.getByRole('button', { name: '切换语言' })).toBeVisible();
  expect(screen.getByRole('button', { name: '切换主题' })).toBeVisible();
  expect(screen.getByRole('button', { name: '管理员登录' })).toBeVisible();
  expect(screen.getByText('中文')).toBeVisible();
});
