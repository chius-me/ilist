import { Download, MoreHorizontal } from 'lucide-react';
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
  fileUrlFor = (item, download, exportFormat) => {
    const query = new URLSearchParams();
    if (download) query.set('download', '1');
    if (exportFormat) query.set('export', exportFormat);
    const suffix = query.toString();
    return `/file/${encodeURIComponent(item.id)}/${encodeURIComponent(item.name)}${suffix ? `?${suffix}` : ''}`;
  },
}: {
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
  interactionProps?: HTMLAttributes<HTMLUListElement>;
  focusedId?: string | null;
  fileUrlFor?: (entry: Entry, download: boolean, exportFormat?: string) => string;
}) {
  const { formatBytes, t } = useI18n();
  return (
    <ul className="fileGrid" aria-label={t('explorer.collection')} {...interactionProps}>
      {entries.map((entry) => {
        const selected = selectedIds.has(entry.id);
        const selectable = admin && isEntryMutable(entry);
        // Guests/share viewers need download access even without export options or admin menus.
        const showActionMenu = admin || entry.capabilities.download;
        const quickExport = entry.exportOptions?.find((option) => option.format === 'pdf') ?? entry.exportOptions?.[0];
        const downloadLabel = quickExport
          ? t('action.exportNamed', { format: quickExport.label, name: entry.name })
          : `${t('action.download')} ${entry.name}`;
        return (
          <li
            id={`explorer-entry-${entry.id}`}
            data-entry-id={entry.id}
            tabIndex={-1}
            className={`fileCard${selected ? ' isSelected' : ''}${focusedId === entry.id ? ' isFocused' : ''}`}
            key={entry.id}
            onContextMenu={(event) => {
              if (!showActionMenu) return;
              event.preventDefault();
              const anchor = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button, a, input') ?? event.currentTarget : event.currentTarget;
              anchor.focus();
              handlers.onMenu(entry, anchor);
            }}
          >
            {selectable ? <input className="gridSelect" type="checkbox" checked={selected} aria-label={t('entry.select', { name: entry.name })} onChange={(event) => handlers.onToggle(entry, { range: (event.nativeEvent as MouseEvent).shiftKey })} /> : null}
            <button className="gridPrimary" type="button" aria-label={`${t('action.open')} ${entry.name}`} onClick={(event) => {
              if (selectable && (event.metaKey || event.ctrlKey || event.shiftKey)) handlers.onToggle(entry, { range: event.shiftKey });
              else if (entry.kind === 'folder') handlers.onOpen(entry);
              else handlers.onPreview(entry);
            }}>
              <span className={`gridMedia ${entry.kind}`}><span className={`gridIcon ${entry.kind}`}><FileIcon entry={entry} size={34} /></span></span>
              <span className="gridFooter">
                <strong title={entry.name}>{entry.name}</strong>
                <small>{entry.kind === 'folder' ? t('entry.folder') : formatBytes(entry.size)}</small>
              </span>
            </button>
            {entry.capabilities.download && !admin ? (
              <a className="gridMenu iconButton" href={fileUrlFor(entry, true, quickExport?.format)} title={downloadLabel} aria-label={downloadLabel}>
                <Download aria-hidden="true" size={17} />
              </a>
            ) : showActionMenu ? (
              <button className="gridMenu iconButton" type="button" title={t('entry.actions', { name: entry.name })} aria-label={t('entry.actions', { name: entry.name })} onClick={(event) => handlers.onMenu(entry, event.currentTarget)}>
                <MoreHorizontal aria-hidden="true" size={17} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
