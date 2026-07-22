import type { Entry } from '../../types/entries';

export type PreviewKind = 'image' | 'video' | 'audio' | 'text' | 'fallback';

const imageContentTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const videoContentTypes = new Set(['video/mp4', 'video/webm']);
const audioContentTypes = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav']);

const textExtensions = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'log', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml',
]);

export function previewKind(entry: Pick<Entry, 'name' | 'contentType'>): PreviewKind {
  const contentType = entry.contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (imageContentTypes.has(contentType)) return 'image';
  if (videoContentTypes.has(contentType)) return 'video';
  if (audioContentTypes.has(contentType)) return 'audio';
  if (contentType === 'application/pdf') return 'fallback';
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') return 'text';

  const extension = entry.name.split('.').pop()?.toLocaleLowerCase();
  if (extension === 'pdf' || extension === 'svg') return 'fallback';
  if (textExtensions.has(extension ?? '')) return 'text';
  return 'fallback';
}
