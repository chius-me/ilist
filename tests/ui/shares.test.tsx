import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../src/ui/app/AppProviders';
import { entryActions } from '../../src/ui/features/explorer/EntryActionMenu';
import { ShareDialog } from '../../src/ui/features/shares/ShareDialog';
import { ShareManager } from '../../src/ui/features/shares/ShareManager';
import type { Entry } from '../../src/ui/types/entries';
import type { ShareView } from '../../src/ui/types/shares';

const entry: Entry = {
  id: 'private-file', parentId: 'root', name: 'private.txt', kind: 'file', size: 12,
  contentType: 'text/plain', updatedAt: '2026-07-18T00:00:00.000Z', isPublic: false,
  effectivePublic: false, sortOrder: 0, description: '', mountPath: null,
  capabilities: { open: false, preview: true, download: true, upload: false, createFolder: false, rename: true, move: true, delete: true, changeVisibility: true },
};

const share: ShareView = {
  id: 'share-1', mountId: 'native-r2', mountName: 'R2', name: 'private.txt', targetKind: 'file',
  protected: false, expiresAt: null, allowDownload: true, enabled: true,
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
};

describe('controlled shares UI', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
  });

  it('offers the share action only when the caller is an administrator', () => {
    const handlers = { onOpen: vi.fn(), onPreview: vi.fn(), onAction: vi.fn() };
    expect(entryActions(entry, handlers).some((action) => action.id === 'share')).toBe(false);
    const actions = entryActions(entry, { ...handlers, canShare: true });
    expect(actions.find((action) => action.id === 'share')?.labelKey).toBe('action.share');
  });

  it('offers explicit Workspace export formats instead of an invalid generic download', () => {
    const workspaceEntry: Entry = {
      ...entry,
      name: 'Project brief',
      contentType: 'application/vnd.google-apps.document',
      exportOptions: [
        { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' },
        { format: 'docx', label: 'DOCX', extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ],
    };
    const actions = entryActions(workspaceEntry, { onOpen: vi.fn(), onPreview: vi.fn(), onAction: vi.fn() });

    expect(actions.some((action) => action.id === 'download')).toBe(false);
    expect(actions.find((action) => action.id === 'export-pdf')).toMatchObject({
      labelKey: 'action.export', labelValues: { format: 'PDF' }, href: expect.stringContaining('export=pdf'),
    });
    expect(actions.find((action) => action.id === 'export-docx')?.href).toContain('export=docx');
  });

  it('creates a protected expiring share and exposes its URL only in the result', async () => {
    const submit = vi.fn(async () => ({ share, url: 'https://ilist.example/s/raw-token-once' }));
    render(<AppProviders><ShareDialog entry={entry} busy={false} error={null} onClose={vi.fn()} onCreate={submit} /></AppProviders>);

    await userEvent.click(screen.getByLabelText('Require password'));
    await userEvent.type(screen.getByLabelText('Password'), 'share-password');
    await userEvent.click(screen.getByLabelText('Set expiration'));
    await userEvent.type(screen.getByLabelText('Expires at'), '2099-01-01T00:00');
    await userEvent.click(screen.getByRole('button', { name: 'Create share' }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      entryId: entry.id, password: 'share-password', allowDownload: true, enabled: true,
      expiresAt: new Date('2099-01-01T00:00').toISOString(),
    })));
    expect(await screen.findByLabelText('Share link')).toHaveValue('https://ilist.example/s/raw-token-once');
    await userEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://ilist.example/s/raw-token-once');
  });

  it('lists and manages shares without rendering recoverable links or internal target IDs', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (url === '/api/admin/shares' && method === 'GET') return Response.json({ ok: true, data: [share] });
      if (url === '/api/admin/shares/share-1' && method === 'PATCH') return Response.json({ ok: true, data: { ...share, enabled: false } });
      if (url === '/api/admin/shares/share-1' && method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }));

    render(<AppProviders><ShareManager /></AppProviders>);
    expect(await screen.findByText('private.txt')).toBeVisible();
    expect(screen.getByText('R2')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/raw-token|providerItemId|tokenHash|private-file/);
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Disable private.txt' }));
    await waitFor(() => expect(requests).toContain('PATCH /api/admin/shares/share-1'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete private.txt' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete share' }));
    await waitFor(() => expect(requests).toContain('DELETE /api/admin/shares/share-1'));
  });
});
