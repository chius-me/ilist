import { AlertCircle, Download, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fileUrl } from '../../api/entries';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { Entry } from '../../types/entries';
import { previewKind } from './preview-kind';

const TEXT_PREVIEW_BYTES = 512 * 1024;

class PreviewResponseError extends Error {
  constructor(readonly status: number) {
    super(`Preview response ${status}`);
  }
}

type PreviewOverlayProps = {
  entry?: Entry | null;
  loading?: boolean;
  error?: Error | null;
  onClose: () => void;
};

async function readTextPreview(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` }, signal });
  if (!response.ok) throw new PreviewResponseError(response.status);
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

function TextPreview({ entry }: { entry: Entry }) {
  const { locale, t } = useFeedbackI18n();
  const url = fileUrl(entry);
  const unavailableMessage = t('preview.unavailable');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);
    void readTextPreview(url, controller.signal).then(setText).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(new Error(reason instanceof PreviewResponseError ? t('preview.loadFailed', { status: reason.status }) : unavailableMessage));
      }
    });
    return () => controller.abort();
  }, [locale, unavailableMessage, url]);

  if (error) return <PreviewError message={error.message} entry={entry} />;
  if (text === null) return <PreviewLoading />;
  return <pre className="previewText">{text}</pre>;
}

function PreviewLoading() {
  const { t } = useFeedbackI18n();
  return <div className="previewStatus" role="status"><LoaderCircle aria-hidden="true" size={20} />{t('preview.loading')}</div>;
}

function PreviewError({ message, entry }: { message: string; entry?: Entry | null }) {
  const { t } = useFeedbackI18n();
  return (
    <div className="previewStatus previewError" role="alert">
      <AlertCircle aria-hidden="true" size={20} />
      <span>{message}</span>
      {entry ? <a href={fileUrl(entry, true)} aria-label={`${t('action.download')} ${entry.name}`}>{t('action.download')}</a> : null}
    </div>
  );
}

function PreviewBody({ entry }: { entry: Entry }) {
  const { formatBytes, t } = useFeedbackI18n();
  const url = fileUrl(entry);
  switch (previewKind(entry)) {
    case 'image': return <img className="previewImage" src={url} alt={entry.name} />;
    case 'video': return <video className="previewVideo" controls src={url}>{t('preview.videoFallback')}</video>;
    case 'audio': return <audio className="previewAudio" controls src={url}>{t('preview.audioFallback')}</audio>;
    case 'pdf': return <iframe className="previewPdf" title={t('preview.pdfTitle')} src={url} />;
    case 'text': return <TextPreview entry={entry} />;
    case 'fallback': return (
      <div className="previewFallback">
        <strong>{t('preview.unavailable')}</strong>
        <dl>
          <div><dt>{t('preview.type')}</dt><dd>{entry.contentType || t('preview.unknown')}</dd></div>
          <div><dt>{t('preview.size')}</dt><dd>{formatBytes(entry.size)}</dd></div>
        </dl>
      </div>
    );
  }
}

export function PreviewOverlay({ entry = null, loading = false, error = null, onClose }: PreviewOverlayProps) {
  const { t } = useFeedbackI18n();
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
    <div className="previewBackdrop overlayScrim overlayScrimStrong">
      <section className="previewOverlay overlaySurface" role="dialog" aria-modal="true" aria-label={entry ? t('preview.title', { name: entry.name }) : t('preview.file')}>
        <header className="previewHeader overlayHeader">
          <h2 title={entry?.name}>{entry?.name || t('preview.file')}</h2>
          <span className="previewHeaderActions">
            {entry && !error ? <a className="iconButton" href={fileUrl(entry, true)} aria-label={`${t('action.download')} ${entry.name}`} title={`${t('action.download')} ${entry.name}`}><Download aria-hidden="true" size={17} /></a> : null}
            <button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label={t('preview.close')} title={t('preview.close')}><X aria-hidden="true" size={18} /></button>
          </span>
        </header>
        <div className="previewBody">
          {loading ? <PreviewLoading /> : null}
          {error ? <PreviewError message={error.message} entry={entry} /> : null}
          {!loading && !error && entry ? <PreviewBody entry={entry} /> : null}
        </div>
      </section>
    </div>
  );
}
