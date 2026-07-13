import { File, Folder, Image, MoreHorizontal } from 'lucide-react';
import { isEntryMutable, type Entry } from '../../types/entries';
import type { EntryHandlers } from './EntryRow';

function GridIcon({ entry }: { entry: Entry }) {
  if (entry.kind === 'folder') return <Folder aria-hidden="true" size={30} />;
  if (entry.contentType?.startsWith('image/')) return <Image aria-hidden="true" size={30} />;
  return <File aria-hidden="true" size={30} />;
}

export function FileGrid({
  entries,
  selectedIds,
  admin,
  handlers,
}: {
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
}) {
  return (
    <ul className="fileGrid" aria-label="Files and folders">
      {entries.map((entry) => {
        const selected = selectedIds.has(entry.id);
        const selectable = admin && isEntryMutable(entry);
        return (
          <li className={`fileCard ${selected ? 'isSelected' : ''}`} key={entry.id} onContextMenu={(event) => { if (admin) { event.preventDefault(); handlers.onMenu(entry); } }}>
            {selectable ? <input className="gridSelect" type="checkbox" checked={selected} aria-label={`Select ${entry.name}`} onChange={() => handlers.onToggle(entry)} /> : null}
            <button className="gridPrimary" type="button" onClick={() => (entry.kind === 'folder' ? handlers.onOpen(entry) : handlers.onPreview(entry))}>
              <span className={`gridIcon ${entry.kind}`}><GridIcon entry={entry} /></span>
              <strong title={entry.name}>{entry.name}</strong>
              <small>{entry.kind === 'folder' ? 'Folder' : entry.contentType || 'File'}</small>
            </button>
            {admin ? <button className="gridMenu iconButton" type="button" title={`Actions for ${entry.name}`} aria-label={`Actions for ${entry.name}`} onClick={() => handlers.onMenu(entry)}><MoreHorizontal aria-hidden="true" size={17} /></button> : null}
          </li>
        );
      })}
    </ul>
  );
}
