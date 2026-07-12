import type { Entry } from '../../types/entries';

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'fallback';

const textExtensions = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'log', 'css', 'js', 'ts', 'tsx', 'jsx', 'html', 'xml',
]);

export function previewKind(entry: Pick<Entry, 'name' | 'contentType'>): PreviewKind {
  const contentType = entry.contentType?.toLocaleLowerCase() ?? '';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') return 'text';

  const extension = entry.name.split('.').pop()?.toLocaleLowerCase();
  if (extension === 'pdf') return 'pdf';
  if (textExtensions.has(extension ?? '')) return 'text';
  return 'fallback';
}
