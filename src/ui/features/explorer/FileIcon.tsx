import { File, FileText, Folder, Image } from 'lucide-react';
import type { Entry } from '../../types/entries';

export function FileIcon({ entry, size }: { entry: Entry; size: number }) {
  if (entry.kind === 'folder') return <Folder aria-hidden="true" size={size} />;
  if (entry.contentType?.startsWith('image/')) return <Image aria-hidden="true" size={size} />;
  if (entry.contentType?.includes('text') || /\.(md|txt|pdf|docx?)$/i.test(entry.name)) {
    return <FileText aria-hidden="true" size={size} />;
  }
  return <File aria-hidden="true" size={size} />;
}
