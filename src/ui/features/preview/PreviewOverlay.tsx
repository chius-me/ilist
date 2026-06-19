import { AlertCircle, Download, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fileUrl } from '../../api/entries';
import { useFeedbackI18n } from '../../components/ToastRegion';
import { useModalFocus } from '../../hooks/useModalFocus';
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
  urlFor?: (entry: Entry, download: boolean, exportFormat?: string) => string;
  allowDownload?: boolean;
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

type PreviewUrlFor = (entry: Entry, download: boolean, exportFormat?: string) => string;

function pdfExport(entry: Entry) {
  return entry.exportOptions?.find((option) => option.format === 'pdf' || option.contentType === 'application/pdf');
}

function TextPreview({ entry, urlFor }: { entry: Entry; urlFor: PreviewUrlFor }) {
  const { locale, t } = useFeedbackI18n();
  const url = urlFor(entry, false);
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

  if (error) return <PreviewError message={error.message} entry={entry} urlFor={urlFor} allowDownload={entry.capabilities.download} />;
  if (text === null) return <PreviewLoading />;
  return <pre className="previewText">{text}</pre>;
}

function PreviewLoading() {
  const { t } = useFeedbackI18n();
  return <div className="previewStatus" role="status"><LoaderCircle aria-hidden="true" size={20} />{t('preview.loading')}</div>;
}

function PreviewError({ message, entry, urlFor = fileUrl, allowDownload = true }: { message: string; entry?: Entry | null; urlFor?: PreviewUrlFor; allowDownload?: boolean }) {
  const { t } = useFeedbackI18n();
  const exportOption = entry ? pdfExport(entry) ?? entry.exportOptions?.[0] : undefined;
  return (
    <div className="previewStatus previewError" role="alert">
      <AlertCircle aria-hidden="true" size={20} />
      <span>{message}</span>
      {entry && allowDownload ? <a href={urlFor(entry, true, exportOption?.format)} aria-label={exportOption ? t('action.exportNamed', { format: exportOption.label, name: entry.name }) : `${t('action.download')} ${entry.name}`}>{exportOption ? t('action.export', { format: exportOption.label }) : t('action.download')}</a> : null}
    </div>
  );
}

function PreviewBody({ entry, urlFor }: { entry: Entry; urlFor: PreviewUrlFor }) {
  const { formatBytes, t } = useFeedbackI18n();
  const url = urlFor(entry, false);
  switch (previewKind(entry)) {
    case 'image': return <img className="previewImage" src={url} alt={entry.name} />;
    case 'video': return <video className="previewVideo" controls src={url}>{t('preview.videoFallback')}</video>;
    case 'audio': return <audio className="previewAudio" controls src={url}>{t('preview.audioFallback')}</audio>;
    case 'text': return <TextPreview entry={entry} urlFor={urlFor} />;
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

export function PreviewOverlay({ entry = null, loading = false, error = null, onClose, urlFor = fileUrl, allowDownload = entry?.capabilities.download ?? true }: PreviewOverlayProps) {
  const { t } = useFeedbackI18n();
  const exportOption = entry ? pdfExport(entry) ?? entry.exportOptions?.[0] : undefined;
  const downloadLabel = entry && exportOption ? t('action.exportNamed', { format: exportOption.label, name: entry.name }) : entry ? `${t('action.download')} ${entry.name}` : '';
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: closeButton, onClose });

  return (
    <div ref={backdrop} className="previewBackdrop overlayScrim overlayScrimStrong">
      <section className="previewOverlay overlaySurface" role="dialog" aria-modal="true" aria-label={entry ? t('preview.title', { name: entry.name }) : t('preview.file')}>
        <header className="previewHeader overlayHeader">
          <h2 title={entry?.name}>{entry?.name || t('preview.file')}</h2>
          <span className="previewHeaderActions">
            {entry && !error && allowDownload ? <a className="iconButton" href={urlFor(entry, true, exportOption?.format)} aria-label={downloadLabel} title={downloadLabel}><Download aria-hidden="true" size={17} /></a> : null}
            <button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label={t('preview.close')} title={t('preview.close')}><X aria-hidden="true" size={18} /></button>
          </span>
        </header>
        <div className="previewBody">
          {loading ? <PreviewLoading /> : null}
          {error ? <PreviewError message={error.message} entry={entry} urlFor={urlFor} allowDownload={allowDownload} /> : null}
          {!loading && !error && entry ? <PreviewBody entry={entry} urlFor={urlFor} /> : null}
        </div>
      </section>
    </div>
  );
}
