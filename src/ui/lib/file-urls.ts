import type { Entry } from '../types/entries';

export function fileUrl(
  entry: Pick<Entry, 'id' | 'name'>,
  download = false,
  exportFormat?: string,
  options?: { sandboxedPreview?: boolean },
): string {
  const url = `/file/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.name)}`;
  const query = new URLSearchParams();
  if (download) query.set('download', '1');
  if (exportFormat) query.set('export', exportFormat);
  if (options?.sandboxedPreview) query.set('preview', '1');
  const suffix = query.toString();
  return suffix ? `${url}?${suffix}` : url;
}

export function publicShareFileUrl(
  token: string,
  entry: Pick<Entry, 'id' | 'name'>,
  download = false,
  exportFormat?: string,
): string {
  const url = `/s/${encodeURIComponent(token)}/file/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.name)}`;
  const query = new URLSearchParams();
  if (download) query.set('download', '1');
  if (exportFormat) query.set('export', exportFormat);
  const suffix = query.toString();
  return suffix ? `${url}?${suffix}` : url;
}
