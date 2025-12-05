import { render, screen } from '@testing-library/react';
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
