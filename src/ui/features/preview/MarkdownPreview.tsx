import { CircleAlert, LoaderCircle } from 'lucide-react';
import { Marked, Renderer } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { Entry } from '../../types/entries';
import { escapeCodeHtml, highlightCodeHtml } from './code-highlight';
import { loadTextPreview, PreviewResponseError, TEXT_PREVIEW_MAX_BYTES, type TextPreviewResult } from './text-loader';

const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const SAFE_IMAGE_SCHEMES = new Set(['http:', 'https:']);

function sanitizeUrl(rawHref: string | null | undefined, allowHash: boolean, allowedSchemes: Set<string>): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!normalized || normalized.startsWith('//')) return null;
  if (normalized.startsWith('#')) return allowHash ? trimmed : null;

  let decoded = normalized;
  try {
    decoded = decodeURIComponent(normalized).replace(/[\u0000-\u0020\u007f]+/g, '');
  } catch {
    // Keep raw normalized URL if percent-decoding fails cleanly.
  }

  for (const candidate of [normalized, decoded]) {
    if (candidate.startsWith('//')) return null;
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(candidate);
    if (schemeMatch) {
      const scheme = `${schemeMatch[1]!.toLowerCase()}:`;
      if (!allowedSchemes.has(scheme)) return null;
    }
  }
  return trimmed;
}

function createSafeMarkdownParser(): Marked {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeCodeHtml(text);
  renderer.heading = function heading({ tokens, depth }) {
    const level = Math.min(6, Math.max(1, depth));
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
  };
  renderer.code = ({ text, lang }) => {
    const highlighted = highlightCodeHtml(text, lang);
    return `<pre class="mdCode"><code class="hljs language-${escapeCodeHtml(highlighted.language)}">${highlighted.html}</code></pre>\n`;
  };
  renderer.link = function link({ href, title, tokens }) {
    const content = this.parser.parseInline(tokens);
    const safeHref = sanitizeUrl(href, true, SAFE_LINK_SCHEMES);
    if (!safeHref) return content;
    const isExternal = /^https?:/i.test(safeHref);
    const titleAttr = title ? ` title="${escapeCodeHtml(title)}"` : '';
    const relAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeCodeHtml(safeHref)}"${titleAttr}${relAttr}>${content}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const safeSrc = sanitizeUrl(href, false, SAFE_IMAGE_SCHEMES);
    if (!safeSrc) return escapeCodeHtml(text || '');
    const titleAttr = title ? ` title="${escapeCodeHtml(title)}"` : '';
    return `<img src="${escapeCodeHtml(safeSrc)}" alt="${escapeCodeHtml(text || '')}"${titleAttr} loading="lazy" decoding="async" />`;
  };
  return new Marked({ gfm: true, breaks: false, renderer });
}

const markdownParser = createSafeMarkdownParser();

export function renderSafeMarkdown(source: string): string {
  return markdownParser.parse(source, { async: false });
}

interface MarkdownPreviewProps {
  entry: Entry;
  url: string;
}

export default function MarkdownPreview({ entry, url }: MarkdownPreviewProps) {
  const { formatBytes, t } = useFeedbackI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [result, setResult] = useState<TextPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    void loadTextPreview(url, controller.signal, entry.size).then(setResult).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof PreviewResponseError ? tRef.current('preview.loadFailed', { status: reason.status }) : tRef.current('preview.unavailable'));
      }
    });
    return () => controller.abort();
  }, [entry.size, url]);

  const html = useMemo(() => (result ? renderSafeMarkdown(result.text) : ''), [result]);

  if (error) {
    return (
      <div className="previewStatus previewError" role="alert">
        <CircleAlert aria-hidden="true" size={20} />
        <span>{error}</span>
      </div>
    );
  }
  if (!result) {
    return <div className="previewStatus" role="status"><LoaderCircle aria-hidden="true" size={20} />{t('preview.loading')}</div>;
  }

  return (
    <div className="markdownPreviewWrap">
      {result.truncated || result.encoding !== 'utf-8' ? (
        <div className="previewMetaBar">
          {result.truncated ? <span>{t('preview.truncated', { bytes: formatBytes(TEXT_PREVIEW_MAX_BYTES) })}</span> : null}
          {result.encoding !== 'utf-8' ? <span>{t('preview.encoding', { encoding: result.encoding.toUpperCase() })}</span> : null}
        </div>
      ) : null}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML output is sanitized by renderSafeMarkdown */}
      <article className="markdownPreviewBody" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
