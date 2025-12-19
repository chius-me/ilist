import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';

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

const file = (id: string, name: string) => ({
  id,
  parentId: 'root',
  name,
  kind: 'file' as const,
  size: 1024,
  contentType: 'text/plain',
  updatedAt: '2026-07-10T00:00:00Z',
  isPublic: true,
  effectivePublic: true,
  sortOrder: 0,
  description: '',
  mountPath: null,
  capabilities,
});

const archive = {
  ...file('archive', 'Archive'),
  kind: 'folder' as const,
  size: 0,
  contentType: null,
  capabilities: { ...capabilities, open: true, preview: false, download: false },
};

const root = {
  ok: true,
  data: {
    current: {
      ...archive,
      id: 'root',
      parentId: null,
      name: '',
      capabilities: { ...archive.capabilities, upload: true, createFolder: true, rename: false, move: false, delete: false, changeVisibility: false },
    },
    breadcrumbs: [{ id: 'root', name: 'ilist', path: '/' }],
    items: [archive, file('first', 'first.txt'), file('second', 'second.txt'), file('third', 'third.txt')],
  },
};

describe('explorer collection interactions', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/admin/me')) return new Response(JSON.stringify({ ok: true, data: { username: 'admin' } }));
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify(root));
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  it('opens on single click without selecting', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Open Archive' }));

    expect(location.pathname).toBe('/Archive');
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('supports anchored range selection and select all', async () => {
    const user = userEvent.setup();
    render(<App />);
    const first = await screen.findByRole('checkbox', { name: 'Select first.txt' });
    const third = screen.getByRole('checkbox', { name: 'Select third.txt' });

    await user.click(first);
    fireEvent.click(third, { shiftKey: true });
    expect(screen.getByText('3 selected')).toBeVisible();

    const collection = screen.getByRole('list', { name: 'Files and folders' });
    fireEvent.keyDown(collection, { key: 'a', metaKey: true });
    expect(screen.getByText('4 selected')).toBeVisible();
  });

  it('uses roving focus for keyboard activation and explicit selection', async () => {
    render(<App />);
    const collection = await screen.findByRole('list', { name: 'Files and folders' });
    collection.focus();

    fireEvent.keyDown(collection, { key: 'ArrowDown' });
    expect(collection).toHaveAttribute('aria-activedescendant', 'explorer-entry-archive');
    fireEvent.keyDown(collection, { key: ' ' });
    expect(screen.getByText('1 selected')).toBeVisible();
    fireEvent.keyDown(collection, { key: 'Escape' });
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    fireEvent.keyDown(collection, { key: 'Enter' });
    expect(location.pathname).toBe('/Archive');
  });

  it('does not intercept collection shortcuts from form controls', async () => {
    render(<App />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Select first.txt' });
    fireEvent.keyDown(checkbox, { key: 'a', metaKey: true });
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('selects mutable entries intersecting a desktop marquee', async () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { pendingFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { if (id === 1) pendingFrame = null; });
    render(<App />);
    const collection = await screen.findByRole('list', { name: 'Files and folders' });
    const rows = [...collection.querySelectorAll<HTMLElement>('[data-entry-id]')];
    rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: index * 40,
      left: 0,
      top: index * 40,
      right: 200,
      bottom: (index + 1) * 40,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    }));

    fireEvent.pointerDown(collection, { button: 0, isPrimary: true, pointerId: 1, clientX: 220, clientY: 45 });
    fireEvent.pointerMove(collection, { pointerId: 1, clientX: 100, clientY: 115 });
    fireEvent.pointerUp(collection, { pointerId: 1, clientX: 100, clientY: 115 });
    act(() => pendingFrame?.(0));

    expect(screen.getByText('2 selected')).toBeVisible();
  });

  it('fits the desktop action menu to its anchor and restores anchor focus', async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = await screen.findByRole('button', { name: 'Actions for first.txt' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 980, y: 700, left: 980, top: 700, right: 1014, bottom: 734, width: 34, height: 34, toJSON: () => ({}),
    });

    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Actions for first.txt' });
    expect(menu).toHaveStyle({ position: 'fixed' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
