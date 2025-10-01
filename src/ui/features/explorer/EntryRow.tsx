import { Download, File, FileText, Folder, Image, MoreHorizontal } from 'lucide-react';
import type { Entry } from '../../types/entries';

export interface EntryHandlers {
  onOpen: (entry: Entry) => void;
  onPreview: (entry: Entry) => void;
  onToggle: (entry: Entry) => void;
  onMenu: (entry: Entry) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === 'folder') return <Folder aria-hidden="true" size={20} />;
  if (entry.contentType?.startsWith('image/')) return <Image aria-hidden="true" size={20} />;
  if (entry.contentType?.includes('text') || /\.(md|txt|pdf|docx?)$/i.test(entry.name)) return <FileText aria-hidden="true" size={20} />;
  return <File aria-hidden="true" size={20} />;
}

export function EntryRow({
  entry,
  selected,
  admin,
  onOpen,
  onPreview,
  onToggle,
  onMenu,
}: EntryHandlers & { entry: Entry; selected: boolean; admin: boolean }) {
  const isFolder = entry.kind === 'folder';
  const activate = () => (isFolder ? onOpen(entry) : onPreview(entry));

  return (
    <li className={`entryRow ${selected ? 'isSelected' : ''}`} onContextMenu={(event) => { if (admin) { event.preventDefault(); onMenu(entry); } }}>
      {admin ? (
        <label className="entrySelect">
          <span className="srOnly">Select {entry.name}</span>
          <input type="checkbox" checked={selected} onChange={() => onToggle(entry)} />
        </label>
      ) : null}
      <button className="entryPrimary" type="button" onClick={activate}>
        <span className={`entryIcon ${isFolder ? 'folder' : 'file'}`}><EntryIcon entry={entry} /></span>
        <span className="entryName">
          <strong title={entry.name}>{entry.name}</strong>
          {entry.description ? <small>{entry.description}</small> : null}
        </span>
        <span className="entryType">{isFolder ? 'Folder' : entry.contentType || 'File'}</span>
        <span className="entrySize">{isFolder ? '—' : formatSize(entry.size)}</span>
        <time className="entryDate" dateTime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
      </button>
      <span className="entryActions">
        {entry.capabilities.download ? <a className="iconButton" href={`/file/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.name)}?download=1`} title={`Download ${entry.name}`} aria-label={`Download ${entry.name}`}><Download aria-hidden="true" size={16} /></a> : null}
        {admin ? (
          <button className="iconButton" type="button" title={`Actions for ${entry.name}`} aria-label={`Actions for ${entry.name}`} onClick={() => onMenu(entry)}>
            <MoreHorizontal aria-hidden="true" size={17} />
          </button>
        ) : null}
      </span>
    </li>
  );
}
