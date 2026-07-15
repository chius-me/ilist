import { MoreHorizontal } from 'lucide-react';
import { isEntryMutable, type Entry } from '../../types/entries';
import { useI18n } from '../../i18n/I18nProvider';
import { FileIcon } from './FileIcon';
import type { EntryHandlers } from './EntryRow';

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
  const { formatBytes, t } = useI18n();
  return (
    <ul className="fileGrid" aria-label="Files and folders">
      {entries.map((entry) => {
        const selected = selectedIds.has(entry.id);
        const selectable = admin && isEntryMutable(entry);
        return (
          <li className={`fileCard${selected ? ' isSelected' : ''}`} key={entry.id} onContextMenu={(event) => { if (admin) { event.preventDefault(); handlers.onMenu(entry, event.currentTarget); } }}>
            {selectable ? <input className="gridSelect" type="checkbox" checked={selected} aria-label={`Select ${entry.name}`} onChange={() => handlers.onToggle(entry)} /> : null}
            <button className="gridPrimary" type="button" aria-label={`${t('action.open')} ${entry.name}`} onClick={() => (entry.kind === 'folder' ? handlers.onOpen(entry) : handlers.onPreview(entry))}>
              <span className={`gridMedia ${entry.kind}`}><FileIcon entry={entry} size={34} /></span>
              <span className="gridFooter">
                <strong title={entry.name}>{entry.name}</strong>
                <small>{entry.kind === 'folder' ? t('entry.folder') : formatBytes(entry.size)}</small>
              </span>
            </button>
            {admin ? <button className="gridMenu iconButton" type="button" title={t('entry.actions', { name: entry.name })} aria-label={t('entry.actions', { name: entry.name })} onClick={(event) => handlers.onMenu(entry, event.currentTarget)}><MoreHorizontal aria-hidden="true" size={17} /></button> : null}
          </li>
        );
      })}
    </ul>
  );
}
