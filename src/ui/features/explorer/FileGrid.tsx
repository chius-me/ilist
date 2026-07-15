import { MoreHorizontal } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { isEntryMutable, type Entry } from '../../types/entries';
import { useI18n } from '../../i18n/I18nProvider';
import { FileIcon } from './FileIcon';
import type { EntryHandlers } from './EntryRow';

export function FileGrid({
  entries,
  selectedIds,
  admin,
  handlers,
  interactionProps,
  focusedId,
}: {
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
  interactionProps?: HTMLAttributes<HTMLUListElement>;
  focusedId?: string | null;
}) {
  const { formatBytes, t } = useI18n();
  return (
    <ul className="fileGrid" aria-label="Files and folders" {...interactionProps}>
      {entries.map((entry) => {
        const selected = selectedIds.has(entry.id);
        const selectable = admin && isEntryMutable(entry);
        return (
          <li
            id={`explorer-entry-${entry.id}`}
            data-entry-id={entry.id}
            tabIndex={-1}
            className={`fileCard${selected ? ' isSelected' : ''}${focusedId === entry.id ? ' isFocused' : ''}`}
            key={entry.id}
            onContextMenu={(event) => {
              if (!admin) return;
              event.preventDefault();
              const anchor = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button, a, input') ?? event.currentTarget : event.currentTarget;
              anchor.focus();
              handlers.onMenu(entry, anchor);
            }}
          >
            {selectable ? <input className="gridSelect" type="checkbox" checked={selected} aria-label={`Select ${entry.name}`} onChange={(event) => handlers.onToggle(entry, { range: (event.nativeEvent as MouseEvent).shiftKey })} /> : null}
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
