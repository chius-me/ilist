import type { Entry } from '../../types/entries';

export type PreviewKind = 'image' | 'video' | 'audio' | 'text' | 'fallback';

const imageContentTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

const textExtensions = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'log', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml',
]);

export function previewKind(entry: Pick<Entry, 'name' | 'contentType'>): PreviewKind {
  const contentType = entry.contentType?.toLocaleLowerCase() ?? '';
  if (imageContentTypes.has(contentType)) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'fallback';
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') return 'text';

  const extension = entry.name.split('.').pop()?.toLocaleLowerCase();
  if (extension === 'pdf' || extension === 'svg') return 'fallback';
  if (textExtensions.has(extension ?? '')) return 'text';
  return 'fallback';
}
