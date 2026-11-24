import { ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPreviewProps {
  url: string;
  title: string;
  downloadUrl?: string;
  downloadLabel?: string;
}

export default function PdfPreview({ url, title, downloadUrl, downloadLabel }: PdfPreviewProps) {
  const { t } = useFeedbackI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    setPageNumber(1);
    setNumPages(0);

    const loadingTask = getDocument({ url });
    void loadingTask.promise.then((pdf) => {
      if (cancelled) {
        void pdf.cleanup();
        return;
      }
      setDoc(pdf);
      setNumPages(pdf.numPages);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setError(tRef.current('preview.unavailable'));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!doc) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let activeRenderTask: RenderTask | null = null;

    void doc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: zoom });
      const renderViewport = page.getViewport({ scale: zoom * dpr });
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      activeRenderTask = page.render({ canvas, viewport: renderViewport });
      return activeRenderTask.promise;
    }).catch((reason: unknown) => {
      if (!cancelled && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) {
        setError(tRef.current('preview.unavailable'));
      }
    });

    return () => {
      cancelled = true;
      activeRenderTask?.cancel();
    };
  }, [doc, pageNumber, zoom]);

  if (error) {
    return (
      <div className="previewStatus previewError" role="alert">
        <CircleAlert aria-hidden="true" size={20} />
        <span>{error}</span>
        {downloadUrl ? <a href={downloadUrl}>{downloadLabel ?? t('action.download')}</a> : null}
      </div>
    );
  }

  return (
    <section className="pdfPreviewWrap" aria-label={title}>
      <div className="previewMetaBar pdfToolbar">
        <span className="pdfControlGroup">
          <button
            className="iconButton"
            type="button"
            disabled={loading || pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
            aria-label={t('preview.previousPage')}
            title={t('preview.previousPage')}
          >
            <ChevronLeft aria-hidden="true" size={16} />
          </button>
          <span className="pdfPageLabel">{numPages > 0 ? t('preview.pageOf', { page: pageNumber, total: numPages }) : '—'}</span>
          <button
            className="iconButton"
            type="button"
            disabled={loading || pageNumber >= numPages}
            onClick={() => setPageNumber((current) => Math.min(numPages, current + 1))}
            aria-label={t('preview.nextPage')}
            title={t('preview.nextPage')}
          >
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        </span>
        <span className="pdfControlGroup">
          <button
            className="iconButton"
            type="button"
            disabled={loading || zoom <= 0.6}
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
            disabled={loading || zoom >= 3}
            onClick={() => setZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))}
            aria-label={t('preview.zoomIn')}
            title={t('preview.zoomIn')}
          >
            <ZoomIn aria-hidden="true" size={16} />
          </button>
          <button
            className="iconButton"
            type="button"
            disabled={loading || zoom === 1.2}
            onClick={() => setZoom(1.2)}
            aria-label={t('preview.zoomReset')}
            title={t('preview.zoomReset')}
          >
            <RotateCcw aria-hidden="true" size={15} />
          </button>
        </span>
      </div>
      <div className="pdfStage">
        {loading ? <div className="previewStatus" role="status"><LoaderCircle aria-hidden="true" size={20} />{t('preview.loading')}</div> : null}
        <canvas ref={canvasRef} className={loading ? 'hiddenCanvas' : 'pdfCanvas'} />
      </div>
    </section>
  );
}
