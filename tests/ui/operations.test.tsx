import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';

const entry = (id: string, name: string, kind: 'file' | 'folder') => ({
  id, parentId: 'root', name, kind, size: kind === 'file' ? 2400 : 0,
  contentType: kind === 'file' ? 'application/pdf' : null,
  updatedAt: '2026-07-10T00:00:00Z', isPublic: true, effectivePublic: true,
  sortOrder: 0, description: '',
  capabilities: { open: kind === 'folder', preview: kind === 'file', download: kind === 'file', rename: true, move: true, delete: true, changeVisibility: true },
});

const root = {
  ok: true,
  data: {
    current: { ...entry('root', '', 'folder'), parentId: null, capabilities: { open: true, preview: false, download: false, rename: false, move: false, delete: false, changeVisibility: false } },
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
});
