import { File, FileArchive, FileCode2, FileSpreadsheet, FileText, Folder, Image, Music, Video } from 'lucide-react';
import type { Entry } from '../../types/entries';

const CODE_EXTENSION_RE = /\.(jsonc?|ya?ml|toml|xml|html?|css|scss|less|[cm]?[jt]sx?|py|sh|bash|zsh|sql|go|rs|java|c|cpp|h|hpp|diff|patch|ini|conf)$/i;
const SPREADSHEET_EXTENSION_RE = /\.(csv|tsv|xlsx?|ods)$/i;
const ARCHIVE_EXTENSION_RE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const VIDEO_EXTENSION_RE = /\.(mp4|webm|mkv|mov|avi)$/i;
const AUDIO_EXTENSION_RE = /\.(mp3|wav|ogg|flac|aac|m4a)$/i;
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const DOC_EXTENSION_RE = /\.(md|markdown|mdx|txt|log|pdf|docx?|rtf)$/i;

export function FileIcon({ entry, size }: { entry: Entry; size: number }) {
  if (entry.kind === 'folder') return <Folder aria-hidden="true" size={size} />;

  const contentType = entry.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType.startsWith('image/') || IMAGE_EXTENSION_RE.test(entry.name)) {
    return <Image aria-hidden="true" size={size} />;
  }
  if (contentType.startsWith('video/') || VIDEO_EXTENSION_RE.test(entry.name)) {
    return <Video aria-hidden="true" size={size} />;
  }
  if (contentType.startsWith('audio/') || AUDIO_EXTENSION_RE.test(entry.name)) {
    return <Music aria-hidden="true" size={size} />;
  }
  if (contentType.includes('spreadsheet') || contentType.includes('excel') || SPREADSHEET_EXTENSION_RE.test(entry.name)) {
    return <FileSpreadsheet aria-hidden="true" size={size} />;
  }
  if (contentType.includes('zip') || contentType.includes('tar') || contentType.includes('compressed') || ARCHIVE_EXTENSION_RE.test(entry.name)) {
    return <FileArchive aria-hidden="true" size={size} />;
  }
  if (
    CODE_EXTENSION_RE.test(entry.name)
    || contentType === 'application/json'
    || contentType === 'application/xml'
    || contentType === 'text/xml'
    || contentType === 'text/javascript'
    || contentType === 'application/javascript'
    || contentType === 'text/css'
  ) {
    return <FileCode2 aria-hidden="true" size={size} />;
  }
  if (contentType.includes('text') || DOC_EXTENSION_RE.test(entry.name)) {
    return <FileText aria-hidden="true" size={size} />;
  }
  return <File aria-hidden="true" size={size} />;
}
