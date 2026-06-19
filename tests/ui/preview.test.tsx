import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewOverlay } from '../../src/ui/features/preview/PreviewOverlay';
import { previewKind } from '../../src/ui/features/preview/preview-kind';

const base = {
  id: 'file-image1', parentId: 'root', name: 'photo.png', kind: 'file' as const, size: 10, contentType: 'image/png',
  updatedAt: '', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', mountPath: null,
  capabilities: { open: false, preview: true, download: true, upload: false, createFolder: false, rename: false, move: false, delete: false, changeVisibility: false },
};

describe('preview', () => {
  it('selects supported preview kinds', () => {
    expect(previewKind(base)).toBe('image');
    expect(previewKind({ ...base, name: 'graphic.svg', contentType: 'image/svg+xml' })).toBe('fallback');
    expect(previewKind({ ...base, name: 'report.pdf', contentType: 'application/pdf' })).toBe('fallback');
    expect(previewKind({ ...base, name: 'notes.md', contentType: 'text/markdown' })).toBe('text');
    expect(previewKind({ ...base, name: 'archive.zip', contentType: 'application/zip' })).toBe('fallback');
  });

  it('renders an image and closes through the supplied history action', () => {
    const onClose = vi.fn();
    render(<PreviewOverlay entry={base} onClose={onClose} />);
    expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute('src', expect.stringContaining('/file/file-image1/'));
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape and restores focus to the opener', () => {
    const onClose = vi.fn();
    render(<button type="button">Open preview</button>);
    screen.getByRole('button', { name: 'Open preview' }).focus();
    const { unmount } = render(<PreviewOverlay entry={base} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Close preview' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(screen.getByRole('button', { name: 'Open preview' })).toHaveFocus();
  });

  it('reads only the first 512 KiB for text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hello text', { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PreviewOverlay entry={{ ...base, name: 'notes.txt', contentType: 'text/plain' }} onClose={() => undefined} />);
    expect(await screen.findByText('hello text')).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { Range: 'bytes=0-524287' } })));
  });

  it('offers a Workspace document export without embedding the PDF', () => {
    const urlFor = vi.fn((_entry, download: boolean, exportFormat?: string) => `/workspace?download=${download ? '1' : '0'}&export=${exportFormat ?? ''}`);
    render(<PreviewOverlay entry={{
      ...base,
      name: 'Project brief',
      contentType: 'application/vnd.google-apps.document',
      exportOptions: [
        { format: 'pdf', label: 'PDF', extension: 'pdf', contentType: 'application/pdf' },
        { format: 'docx', label: 'DOCX', extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ],
    }} urlFor={urlFor} onClose={() => undefined} />);

    expect(screen.queryByTitle('PDF preview')).not.toBeInTheDocument();
    expect(screen.getByText('Preview is not available for this file type.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Export PDF Project brief' })).toHaveAttribute('href', '/workspace?download=1&export=pdf');
  });
});
