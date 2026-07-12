import { AlertCircle, Download, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fileUrl } from '../../api/entries';
import type { Entry } from '../../types/entries';
import { previewKind } from './preview-kind';

const TEXT_PREVIEW_BYTES = 512 * 1024;

type PreviewOverlayProps = {
  entry?: Entry | null;
  loading?: boolean;
  error?: Error | null;
  onClose: () => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

async function readTextPreview(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` }, signal });
  if (!response.ok) throw new Error(`Unable to load preview (${response.status})`);
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let remaining = TEXT_PREVIEW_BYTES;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      remaining -= chunk.byteLength;
      if (remaining === 0) await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }

  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);
    void readTextPreview(url, controller.signal).then(setText).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason : new Error('Unable to load preview'));
    });
    return () => controller.abort();
  }, [url]);

  if (error) return <PreviewError message={error.message} />;
  if (text === null) return <PreviewLoading />;
  return <pre className="previewText">{text}</pre>;
}

function PreviewLoading() {
  return <div className="previewStatus" role="status"><LoaderCircle aria-hidden="true" size={20} />Loading preview</div>;
}

function PreviewError({ message }: { message: string }) {
  return <div className="previewStatus previewError" role="alert"><AlertCircle aria-hidden="true" size={20} />{message}</div>;
}

function PreviewBody({ entry }: { entry: Entry }) {
  const url = fileUrl(entry);
  switch (previewKind(entry)) {
    case 'image': return <img className="previewImage" src={url} alt={entry.name} />;
    case 'video': return <video className="previewVideo" controls src={url}>Your browser cannot play this video.</video>;
    case 'audio': return <audio className="previewAudio" controls src={url}>Your browser cannot play this audio file.</audio>;
    case 'pdf': return <iframe className="previewPdf" title="PDF preview" src={url} />;
    case 'text': return <TextPreview url={url} />;
    case 'fallback': return (
      <div className="previewFallback">
        <strong>Preview is not available for this file type.</strong>
        <dl>
          <div><dt>Type</dt><dd>{entry.contentType || 'Unknown'}</dd></div>
          <div><dt>Size</dt><dd>{formatSize(entry.size)}</dd></div>
        </dl>
      </div>
    );
  }
}

export function PreviewOverlay({ entry = null, loading = false, error = null, onClose }: PreviewOverlayProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      previouslyFocused.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="previewBackdrop">
      <section className="previewOverlay" role="dialog" aria-modal="true" aria-label={entry ? `Preview ${entry.name}` : 'File preview'}>
        <header className="previewHeader">
          <h2 title={entry?.name}>{entry?.name || 'File preview'}</h2>
          <span className="previewHeaderActions">
            {entry ? <a className="iconButton" href={fileUrl(entry, true)} aria-label={`Download ${entry.name}`} title={`Download ${entry.name}`}><Download aria-hidden="true" size={17} /></a> : null}
            <button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label="Close preview" title="Close preview"><X aria-hidden="true" size={18} /></button>
          </span>
        </header>
        <div className="previewBody">
          {loading ? <PreviewLoading /> : null}
          {error ? <PreviewError message={error.message} /> : null}
          {!loading && !error && entry ? <PreviewBody entry={entry} /> : null}
        </div>
      </section>
    </div>
  );
}
