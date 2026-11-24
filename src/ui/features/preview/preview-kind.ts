import type { Entry } from '../../types/entries';

export type PreviewKind = 'image' | 'video' | 'audio' | 'markdown' | 'code' | 'text' | 'pdf' | 'fallback';

const imageContentTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const videoContentTypes = new Set(['video/mp4', 'video/webm']);
const audioContentTypes = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav']);

const markdownExtensions = new Set(['md', 'markdown', 'mdx']);
const codeExtensions = new Set([
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'sh', 'bash', 'zsh',
  'sql', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'diff', 'patch', 'ini', 'conf',
]);
const textExtensions = new Set(['txt', 'log', 'csv', 'tsv', 'srt', 'vtt']);

const markdownContentTypes = new Set(['text/markdown', 'text/x-markdown']);
const codeContentTypes = new Set([
  'application/json',
  'application/xml',
  'text/xml',
  'application/yaml',
  'text/yaml',
  'text/x-yaml',
  'text/css',
  'text/javascript',
  'application/javascript',
  'text/x-python',
  'application/x-sh',
  'application/sql',
]);

function normalizeContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function previewKind(entry: Pick<Entry, 'name' | 'contentType'>): PreviewKind {
  const contentType = normalizeContentType(entry.contentType);
  if (contentType?.startsWith('application/vnd.google-apps.')) return 'fallback';
  if (contentType && imageContentTypes.has(contentType)) return 'image';
  if (contentType && videoContentTypes.has(contentType)) return 'video';
  if (contentType && audioContentTypes.has(contentType)) return 'audio';
  if (contentType === 'application/pdf') return 'pdf';

  const ext = fileExtension(entry.name);
  if (contentType && markdownContentTypes.has(contentType)) return 'markdown';
  if (contentType && codeContentTypes.has(contentType)) {
    return markdownExtensions.has(ext) ? 'markdown' : 'code';
  }

  if (!contentType || contentType === 'application/octet-stream' || contentType.startsWith('text/')) {
    if (markdownExtensions.has(ext)) return 'markdown';
    if (codeExtensions.has(ext)) return 'code';
    if (textExtensions.has(ext) || contentType?.startsWith('text/')) return 'text';
  }

  return 'fallback';
}

export function isSafeGridThumbnail(entry: Pick<Entry, 'contentType' | 'size' | 'capabilities'>): boolean {
  if (!entry.capabilities.preview || entry.size > 10 * 1024 * 1024) return false;
  const contentType = normalizeContentType(entry.contentType);
  return Boolean(contentType && imageContentTypes.has(contentType));
}
