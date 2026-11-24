import { ChevronLeft, ChevronRight, CircleAlert, Download, LoaderCircle, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { fileUrl } from '../../api/entries';
import { useFeedbackI18n } from '../../components/ToastRegion';
import { useModalFocus } from '../../hooks/useModalFocus';
import type { Entry } from '../../types/entries';
import { previewKind } from './preview-kind';
import { loadTextPreview, PreviewResponseError, TEXT_PREVIEW_MAX_BYTES, type TextPreviewResult } from './text-loader';

const PdfPreview = lazy(() => import('./PdfPreview'));
const MarkdownPreview = lazy(() => import('./MarkdownPreview'));
const CodePreview = lazy(() => import('./CodePreview'));

type PreviewUrlFor = (entry: Entry, download: boolean, exportFormat?: string) => string;

type PreviewOverlayProps = {
  entry?: Entry | null;
  entries?: Entry[];
  onSelectEntry?: (entry: Entry) => void;
  loading?: boolean;
  error?: Error | null;
  onClose: () => void;
  urlFor?: PreviewUrlFor;
  allowDownload?: boolean;
};

function pdfExport(entry: Entry) {
  return entry.exportOptions?.find((option) => option.format === 'pdf' || option.contentType === 'application/pdf');
}

function urlWithPreview(base: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}preview=1`;
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
      <CircleAlert aria-hidden="true" size={20} />
      <span>{message}</span>
      {entry && allowDownload ? <a href={urlFor(entry, true, exportOption?.format)} aria-label={exportOption ? t('action.exportNamed', { format: exportOption.label, name: entry.name }) : `${t('action.download')} ${entry.name}`}>{exportOption ? t('action.export', { format: exportOption.label }) : t('action.download')}</a> : null}
    </div>
  );
}

function TextPreview({ entry, urlFor, allowDownload }: { entry: Entry; urlFor: PreviewUrlFor; allowDownload: boolean }) {
  const { formatBytes, t } = useFeedbackI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const url = urlFor(entry, false);
  const [result, setResult] = useState<TextPreviewResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    void loadTextPreview(url, controller.signal, entry.size).then(setResult).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(new Error(reason instanceof PreviewResponseError ? tRef.current('preview.loadFailed', { status: reason.status }) : tRef.current('preview.unavailable')));
      }
    });
    return () => controller.abort();
  }, [entry.size, url]);

  if (error) return <PreviewError message={error.message} entry={entry} urlFor={urlFor} allowDownload={allowDownload} />;
  if (!result) return <PreviewLoading />;
  if (!result.truncated && result.encoding === 'utf-8') {
    return <pre className="previewText">{result.text}</pre>;
  }
  return (
    <div className="textPreviewWrap">
      <div className="previewMetaBar">
        {result.truncated ? <span>{t('preview.truncated', { bytes: formatBytes(TEXT_PREVIEW_MAX_BYTES) })}</span> : null}
        {result.encoding !== 'utf-8' ? <span>{t('preview.encoding', { encoding: result.encoding.toUpperCase() })}</span> : null}
      </div>
      <pre className="previewText">{result.text}</pre>
    </div>
  );
}

function ImagePreview({ url, alt }: { url: string; alt: string }) {
  const { t } = useFeedbackI18n();
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const transformed = zoom !== 1 || rotation !== 0;

  return (
    <div className="imagePreviewWrap">
      <div className="previewMetaBar imageToolbar">
        <span className="pdfControlGroup">
          <button
            className="iconButton"
            type="button"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((current) => Math.max(0.5, Number((current - 0.25).toFixed(2))))}
            aria-label={t('preview.zoomOut')}
            title={t('preview.zoomOut')}
          >
            <ZoomOut aria-hidden="true" size={16} />
          </button>
          <span className="pdfZoomLabel">{Math.round(zoom * 100)}%</span>
          <button
            className="iconButton"
            type="button"
            disabled={zoom >= 4}
            onClick={() => setZoom((current) => Math.min(4, Number((current + 0.25).toFixed(2))))}
            aria-label={t('preview.zoomIn')}
            title={t('preview.zoomIn')}
          >
            <ZoomIn aria-hidden="true" size={16} />
          </button>
          <button
            className="iconButton"
            type="button"
            onClick={() => setRotation((current) => (current + 90) % 360)}
            aria-label={t('preview.rotate')}
            title={t('preview.rotate')}
          >
            <RotateCw aria-hidden="true" size={16} />
          </button>
          <button
            className="iconButton"
            type="button"
            disabled={!transformed}
            onClick={() => { setZoom(1); setRotation(0); }}
            aria-label={t('preview.zoomReset')}
            title={t('preview.zoomReset')}
          >
            <RotateCcw aria-hidden="true" size={15} />
          </button>
        </span>
      </div>
      <div className="imageStage">
        <img
          className="previewImage"
          src={url}
          alt={alt}
          style={transformed ? { transform: `scale(${zoom}) rotate(${rotation}deg)` } : undefined}
        />
      </div>
    </div>
  );
}

function PreviewBody({ entry, urlFor, allowDownload }: { entry: Entry; urlFor: PreviewUrlFor; allowDownload: boolean }) {
  const { formatBytes, t } = useFeedbackI18n();
  const [previewExportPdf, setPreviewExportPdf] = useState(false);
  const url = urlFor(entry, false);
  const kind = previewKind(entry);
  const exportOption = pdfExport(entry);

  switch (kind) {
    case 'image': return <ImagePreview url={url} alt={entry.name} />;
    case 'video': return <video className="previewVideo" controls src={url}>{t('preview.videoFallback')}</video>;
    case 'audio': return <audio className="previewAudio" controls src={url}>{t('preview.audioFallback')}</audio>;
    case 'markdown': return <Suspense fallback={<PreviewLoading />}><MarkdownPreview entry={entry} url={url} /></Suspense>;
    case 'code': return <Suspense fallback={<PreviewLoading />}><CodePreview entry={entry} url={url} /></Suspense>;
    case 'text': return <TextPreview entry={entry} urlFor={urlFor} allowDownload={allowDownload} />;
    case 'pdf': return (
      <Suspense fallback={<PreviewLoading />}>
        <PdfPreview
          url={urlWithPreview(url)}
          title={t('preview.pdfTitle')}
          downloadUrl={allowDownload ? urlFor(entry, true) : undefined}
          downloadLabel={allowDownload ? `${t('action.download')} ${entry.name}` : undefined}
        />
      </Suspense>
    );
    case 'fallback': {
      if (previewExportPdf && exportOption) {
        return (
          <Suspense fallback={<PreviewLoading />}>
            <PdfPreview
              url={urlWithPreview(urlFor(entry, false, exportOption.format))}
              title={t('preview.pdfTitle')}
              downloadUrl={allowDownload ? urlFor(entry, true, exportOption.format) : undefined}
              downloadLabel={allowDownload ? t('action.exportNamed', { format: exportOption.label, name: entry.name }) : undefined}
            />
          </Suspense>
        );
      }
      return (
        <div className="previewFallback">
          <strong>{t('preview.unavailable')}</strong>
          <dl>
            <div><dt>{t('preview.type')}</dt><dd>{entry.contentType || t('preview.unknown')}</dd></div>
            <div><dt>{t('preview.size')}</dt><dd>{formatBytes(entry.size)}</dd></div>
          </dl>
          {exportOption ? (
            <button className="secondaryButton" type="button" onClick={() => setPreviewExportPdf(true)}>
              {t('preview.previewPdf')}
            </button>
          ) : null}
        </div>
      );
    }
  }
}

export function PreviewOverlay({
  entry = null,
  entries,
  onSelectEntry,
  loading = false,
  error = null,
  onClose,
  urlFor = fileUrl,
  allowDownload = entry?.capabilities.download ?? true,
}: PreviewOverlayProps) {
  const { t } = useFeedbackI18n();
  const exportOption = entry ? pdfExport(entry) ?? entry.exportOptions?.[0] : undefined;
  const downloadLabel = entry && exportOption ? t('action.exportNamed', { format: exportOption.label, name: entry.name }) : entry ? `${t('action.download')} ${entry.name}` : '';
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: closeButton, onClose });

  const { previousEntry, nextEntry, showNavigation } = useMemo(() => {
    if (!entry || !entries || !onSelectEntry) {
      return { previousEntry: null, nextEntry: null, showNavigation: false };
    }
    const siblings = entries.filter((item) => item.kind === 'file');
    const currentIndex = siblings.findIndex((item) => item.id === entry.id);
    return {
      previousEntry: currentIndex > 0 ? siblings[currentIndex - 1] ?? null : null,
      nextEntry: currentIndex >= 0 && currentIndex < siblings.length - 1 ? siblings[currentIndex + 1] ?? null : null,
      showNavigation: siblings.length > 1 && currentIndex >= 0,
    };
  }, [entries, entry, onSelectEntry]);

  useEffect(() => {
    if (!showNavigation || !onSelectEntry) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (event.key === 'ArrowLeft' && previousEntry) {
        event.preventDefault();
        onSelectEntry(previousEntry);
      } else if (event.key === 'ArrowRight' && nextEntry) {
        event.preventDefault();
        onSelectEntry(nextEntry);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextEntry, onSelectEntry, previousEntry, showNavigation]);

  return (
    <div ref={backdrop} className="previewBackdrop overlayScrim overlayScrimStrong" onMouseDown={onClose}>
      <section className="previewOverlay overlaySurface" role="dialog" aria-modal="true" aria-label={entry ? t('preview.title', { name: entry.name }) : t('preview.file')} onMouseDown={(event) => event.stopPropagation()}>
        <header className="previewHeader overlayHeader">
          <h2 title={entry?.name}>{entry?.name || t('preview.file')}</h2>
          <span className="previewHeaderActions">
            {showNavigation ? (
              <>
                <button className="iconButton" type="button" disabled={!previousEntry} onClick={() => previousEntry && onSelectEntry?.(previousEntry)} aria-label={t('preview.previousFile')} title={t('preview.previousFile')}><ChevronLeft aria-hidden="true" size={17} /></button>
                <button className="iconButton" type="button" disabled={!nextEntry} onClick={() => nextEntry && onSelectEntry?.(nextEntry)} aria-label={t('preview.nextFile')} title={t('preview.nextFile')}><ChevronRight aria-hidden="true" size={17} /></button>
              </>
            ) : null}
            {entry && !error && allowDownload ? <a className="iconButton" href={urlFor(entry, true, exportOption?.format)} aria-label={downloadLabel} title={downloadLabel}><Download aria-hidden="true" size={17} /></a> : null}
            <button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label={t('preview.close')} title={t('preview.close')}><X aria-hidden="true" size={18} /></button>
          </span>
        </header>
        <div className="previewBody">
          {loading ? <PreviewLoading /> : null}
          {error ? <PreviewError message={error.message} entry={entry} urlFor={urlFor} allowDownload={allowDownload} /> : null}
          {!loading && !error && entry ? <PreviewBody key={entry.id} entry={entry} urlFor={urlFor} allowDownload={allowDownload} /> : null}
        </div>
      </section>
    </div>
  );
}
