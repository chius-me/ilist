import { Check, CircleAlert, Copy, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { Entry } from '../../types/entries';
import { detectCodeLanguage, highlightCodeHtml } from './code-highlight';
import { loadTextPreview, PreviewResponseError, TEXT_PREVIEW_MAX_BYTES, type TextPreviewResult } from './text-loader';

interface CodePreviewProps {
  entry: Entry;
  url: string;
}

export default function CodePreview({ entry, url }: CodePreviewProps) {
  const { formatBytes, t } = useFeedbackI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [result, setResult] = useState<TextPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    setCopied(false);
    void loadTextPreview(url, controller.signal, entry.size).then(setResult).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof PreviewResponseError ? tRef.current('preview.loadFailed', { status: reason.status }) : tRef.current('preview.unavailable'));
      }
    });
    return () => controller.abort();
  }, [entry.size, url]);

  const detectedLanguage = useMemo(() => detectCodeLanguage(entry.name, entry.contentType), [entry.contentType, entry.name]);
  const highlighted = useMemo(
    () => (result ? highlightCodeHtml(result.text, detectedLanguage) : null),
    [detectedLanguage, result],
  );
  const lineCount = useMemo(() => (result ? result.text.split('\n').length : 0), [result]);

  if (error) {
    return (
      <div className="previewStatus previewError" role="alert">
        <CircleAlert aria-hidden="true" size={20} />
        <span>{error}</span>
      </div>
    );
  }
  if (!result || !highlighted) {
    return <div className="previewStatus" role="status"><LoaderCircle aria-hidden="true" size={20} />{t('preview.loading')}</div>;
  }

  return (
    <div className="codePreviewWrap">
      <div className="previewMetaBar codePreviewBar">
        <span className="codeMetaGroup">
          <span className="badge badgeNeutral">{highlighted.language}</span>
          {result.encoding !== 'utf-8' ? <span className="badge badgeNeutral">{result.encoding.toUpperCase()}</span> : null}
          {result.truncated ? <span>{t('preview.truncated', { bytes: formatBytes(TEXT_PREVIEW_MAX_BYTES) })}</span> : null}
        </span>
        <button
          className="secondaryButton compactButton"
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(result.text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            }).catch(() => undefined);
          }}
        >
          {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
          <span>{copied ? t('preview.copied') : t('preview.copyCode')}</span>
        </button>
      </div>
      <div className="codeScroll">
        <div className="codeLines" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, idx) => idx + 1).map((lineNumber) => (
            <span key={lineNumber}>{lineNumber}</span>
          ))}
        </div>
        <pre className="codePre">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML output is escaped/highlighted by highlightCodeHtml */}
          <code className={`hljs language-${highlighted.language}`} dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        </pre>
      </div>
    </div>
  );
}
