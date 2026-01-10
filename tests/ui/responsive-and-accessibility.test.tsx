import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { MobileActionSheet } from '../../src/ui/features/explorer/MobileActionSheet';
import { MountDialog } from '../../src/ui/features/mounts/MountDialog';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { FileGrid } from '../../src/ui/features/explorer/FileGrid';
import { FileList } from '../../src/ui/features/explorer/FileList';
import type { Entry } from '../../src/ui/types/entries';
import { useUploadQueue } from '../../src/ui/features/uploads/useUploadQueue';

const report: Entry = {
  id: 'report-file',
  parentId: 'root',
  name: 'report.pdf',
  kind: 'file',
  size: 2048,
  contentType: 'application/pdf',
  updatedAt: '2026-07-10T00:00:00Z',
  isPublic: true,
  effectivePublic: true,
  sortOrder: 0,
  description: '',
  mountPath: null,
  capabilities: { open: false, preview: true, download: true, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false },
};

const root = {
  ok: true,
  data: {
    current: {
      ...report,
      id: 'root',
      parentId: null,
      name: '',
      kind: 'folder',
      size: 0,
      contentType: null,
      capabilities: { ...report.capabilities, open: true, upload: true, createFolder: true },
    },
    breadcrumbs: [],
    items: [report],
  },
};

describe('responsive actions', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    it(`renders primary surfaces in ${locale}`, async () => {
      localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale, theme: 'light', defaultView: 'list' }));
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/admin/me')) return Response.json({ ok: true, data: { username: 'admin' } });
        if (url.includes('/api/fs/list')) return Response.json(root);
        throw new Error(`Unexpected fetch: ${url}`);
      }));
      render(<App />);

      expect(await screen.findByRole('main')).toBeVisible();
      expect(await screen.findByRole('button', { name: locale === 'en' ? 'Upload files' : '上传文件' })).toBeVisible();
    });
  }

  it('localizes upload queue validation errors', async () => {
    localStorage.setItem('ilist.ui.preferences', JSON.stringify({ version: 1, locale: 'zh-CN', theme: 'light', defaultView: 'list' }));
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders>{children}</AppProviders>;
    const { result } = renderHook(() => useUploadQueue({ transport: vi.fn(), onCompleted: vi.fn() }), { wrapper });

    act(() => result.current.enqueue('root', [new File([''], '   ')]));
    await waitFor(() => expect(result.current.tasks[0]?.error).toBe('文件名无效'));
  });

  it('keeps explicit open and separate action controls in both collection views', () => {
    const handlers = { onOpen: vi.fn(), onPreview: vi.fn(), onToggle: vi.fn(), onMenu: vi.fn() };

    for (const view of ['list', 'grid'] as const) {
      const { unmount } = render(
        <AppProviders>
          {view === 'list'
            ? <FileList entries={[report]} selectedIds={new Set()} admin handlers={handlers} />
            : <FileGrid entries={[report]} selectedIds={new Set()} admin handlers={handlers} />}
        </AppProviders>,
      );
      const open = screen.getByRole('button', { name: 'Open report.pdf' });
      expect(open).not.toContainElement(screen.getByRole('button', { name: 'Actions for report.pdf' }));
      unmount();
    }
  });

  it('exposes the same actions in a labeled mobile dialog and closes on Escape', () => {
    const onClose = vi.fn();
    render(<MobileActionSheet open title="Actions for report.pdf" actions={[{ id: 'download', label: 'Download', onSelect: () => undefined }]} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Actions for report.pdf' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns focus to its trigger when closed', () => {
    const onClose = vi.fn();
    render(<button type="button">Actions for report.pdf</button>);
    const trigger = screen.getByRole('button', { name: 'Actions for report.pdf' });
    trigger.focus();
    const { unmount } = render(<MobileActionSheet open title="Actions for report.pdf" actions={[]} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();
  });

  it('focuses the storage name and closes the storage sheet on Escape', () => {
    const onClose = vi.fn();
    render(<AppProviders><MountDialog mount={null} busy={false} error={null} onClose={onClose} onSubmit={vi.fn()} /></AppProviders>);

    expect(screen.getByLabelText('Display name')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
