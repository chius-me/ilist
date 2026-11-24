import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderSafeMarkdown } from '../../src/ui/features/preview/MarkdownPreview';
import { decodePreviewBytes } from '../../src/ui/features/preview/text-loader';
import { PreviewOverlay } from '../../src/ui/features/preview/PreviewOverlay';
import { previewKind } from '../../src/ui/features/preview/preview-kind';

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/mock-pdf.worker.mjs' }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      })),
      destroy: vi.fn(async () => undefined),
    }),
    destroy: vi.fn(async () => undefined),
  })),
}));

const base = {
  id: 'file-image1', parentId: 'root', name: 'photo.png', kind: 'file' as const, size: 10, contentType: 'image/png',
  updatedAt: '', isPublic: true, effectivePublic: true, sortOrder: 0, description: '', mountPath: null,
  capabilities: { open: false, preview: true, download: true, upload: false, createFolder: false, rename: false, move: false,
    copy: false, delete: false, changeVisibility: false },
};

describe('preview', () => {
  it('selects supported preview kinds', () => {
    expect(previewKind(base)).toBe('image');
    expect(previewKind({ ...base, name: 'graphic.svg', contentType: 'image/svg+xml' })).toBe('fallback');
    expect(previewKind({ ...base, name: 'report.pdf', contentType: 'application/pdf' })).toBe('pdf');
    expect(previewKind({ ...base, name: 'notes.md', contentType: 'text/markdown' })).toBe('markdown');
    expect(previewKind({ ...base, name: 'app.ts', contentType: 'text/plain' })).toBe('code');
    expect(previewKind({ ...base, name: 'archive.zip', contentType: 'application/zip' })).toBe('fallback');
  });

  it.each([
    ['IMAGE/JPEG; charset=binary', 'image'],
    ['video/mp4; codecs="avc1.64001f"', 'video'],
    ['Audio/Ogg; codecs=opus', 'audio'],
  ] as const)('normalizes parameterized MIME %s before preview classification', (contentType, kind) => {
    expect(previewKind({ ...base, name: 'media.bin', contentType })).toBe(kind);
  });

  it.each([
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
    ['audio/mpeg', 'audio'],
    ['audio/ogg', 'audio'],
    ['audio/wav', 'audio'],
  ] as const)('allows Worker-inline media MIME %s', (contentType, kind) => {
    expect(previewKind({ ...base, name: 'media.bin', contentType })).toBe(kind);
  });

  it.each([
    'image/svg+xml',
    'image/bmp',
    'video/quicktime',
    'video/x-matroska',
    'audio/flac',
    'audio/aac',
  ])('rejects media MIME outside the Worker inline allowlist: %s', (contentType) => {
    expect(previewKind({ ...base, name: 'media.bin', contentType })).toBe('fallback');
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

  it('offers a Workspace document export without embedding the PDF', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Preview PDF' }));
    expect(await screen.findByRole('region', { name: 'PDF preview' })).toBeVisible();
    expect(await screen.findByText('Page 1 of 2')).toBeVisible();
  });

  it('sanitizes unsafe Markdown HTML and URLs without double-escaping inline code', () => {
    const output = renderSafeMarkdown([
      '# Title',
      '<script>alert(1)</script>',
      'Inline <img src=x onerror=alert(1)> html and `<script>safe</script>`.',
      '[bad](javascript:alert(1)) [obfuscated](java\tscript:alert(1)) [ref][id]',
      '![img](data:text/html,<script>1</script>) [ok](https://example.com)',
      '',
      '[id]: javascript:alert(2)',
    ].join('\n\n'));

    const container = document.createElement('div');
    container.innerHTML = output;
    expect(container.querySelectorAll('script, img, [onerror]')).toHaveLength(0);
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('javascript:');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(output).toContain('<code>&lt;script&gt;safe&lt;/script&gt;</code>');
    expect(output).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
  });

  it('decodes GB18030 text and tolerates split UTF-8 characters at truncation boundaries', () => {
    // "中文" in GBK/GB18030: 0xD6 0xD0 0xCE 0xC4 (invalid UTF-8)
    const gbBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const gbResult = decodePreviewBytes(gbBytes, false);
    expect(gbResult.encoding).toBe('gb18030');
    expect(gbResult.text).toBe('中文');

    // "你好" UTF-8 is E4 BD A0 E5 A5 BD; truncate last byte cleanly -> E4 BD A0 E5 A5
    const splitUtf8 = new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5]);
    const utf8Result = decodePreviewBytes(splitUtf8, true);
    expect(utf8Result.encoding).toBe('utf-8');
    expect(utf8Result.text).toBe('你');
  });

  it('renders syntax-highlighted code with copy button and navigates sibling files', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('const answer = 42;', { status: 200 })));

    const codeEntry = { ...base, id: 'file-code', name: 'index.ts', contentType: 'text/plain', size: 18 };
    const entries = [base, codeEntry];
    const onSelectEntry = vi.fn();

    const { rerender } = render(
      <PreviewOverlay entry={base} entries={entries} onSelectEntry={onSelectEntry} onClose={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate 90°' }));
    expect(screen.getByRole('img', { name: 'photo.png' })).toHaveStyle({ transform: 'scale(1.25) rotate(90deg)' });

    fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
    expect(onSelectEntry).toHaveBeenCalledWith(codeEntry);

    rerender(
      <PreviewOverlay entry={codeEntry} entries={entries} onSelectEntry={onSelectEntry} onClose={() => undefined} />,
    );
    expect(await screen.findByText('const', { selector: '.hljs-keyword' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42;'));

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onSelectEntry).toHaveBeenLastCalledWith(base);
  });
});
