import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
