import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { useExplorerLocation } from '../../src/ui/hooks/useExplorerLocation';
import { useSession } from '../../src/ui/hooks/useSession';

describe('explorer foundations', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/R2/Projects');
    vi.restoreAllMocks();
  });

  it('pushes folders and preview IDs into browser history', () => {
    const { result } = renderHook(() => useExplorerLocation());
    act(() => result.current.openPath('/R2/项目'));
    expect(location.pathname).toBe('/R2/%E9%A1%B9%E7%9B%AE');
    act(() => result.current.openPreview('file-12345678'));
    expect(new URL(location.href).searchParams.get('preview')).toBe('file-12345678');
    act(() => result.current.closePreview());
    expect(new URL(location.href).searchParams.has('preview')).toBe(false);
  });

  it('treats a 401 me response as guest state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.status).toBe('guest'));
    expect(result.current.user).toBeNull();
  });

  it('guards malformed percent encoding in openPath and reacts to popstate between explorer and share routes', async () => {
    const { result } = renderHook(() => useExplorerLocation());
    act(() => result.current.openPath('/folder/bad%ZZname'));
    expect(location.pathname).toBe('/folder/bad%25ZZname');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/s/token-1/api') return Response.json({ ok: false, error: { code: 'SHARE_PASSWORD_REQUIRED', message: 'required' } }, { status: 401 });
      if (url.includes('/api/admin/me')) return Response.json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'required' } }, { status: 401 });
      if (url.includes('/api/fs/list')) {
        return Response.json({
          ok: true,
          data: {
            current: { id: 'root', parentId: null, name: 'iList', kind: 'folder', size: 0, contentType: null, updatedAt: '', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', mountPath: null, capabilities: { open: true, preview: false, download: false, upload: false, createFolder: false, rename: false, move: false, copy: false, delete: false, changeVisibility: false } },
            breadcrumbs: [],
            items: [],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    history.replaceState(null, '', '/');
    render(<App />);
    expect(await screen.findByText('This folder is empty')).toBeVisible();

    act(() => {
      history.pushState(null, '', '/s/token-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('heading', { name: 'Protected share' })).toBeVisible();
  });
});
