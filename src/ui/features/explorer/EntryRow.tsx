import { Download, MoreHorizontal } from 'lucide-react';
import { isEntryMutable, type Entry } from '../../types/entries';
import { useI18n } from '../../i18n/I18nProvider';
import { FileIcon } from './FileIcon';

export interface EntryHandlers {
  onOpen: (entry: Entry) => void;
  onPreview: (entry: Entry) => void;
  onToggle: (entry: Entry, options?: { range?: boolean }) => void;
  onMenu: (entry: Entry, anchor?: HTMLElement) => void;
}

export function EntryRow({
  entry,
  selected,
  focused = false,
  admin,
  onOpen,
  onPreview,
  onToggle,
  onMenu,
  fileUrlFor = (item, download, exportFormat) => {
    const query = new URLSearchParams();
    if (download) query.set('download', '1');
    if (exportFormat) query.set('export', exportFormat);
    const suffix = query.toString();
    return `/file/${encodeURIComponent(item.id)}/${encodeURIComponent(item.name)}${suffix ? `?${suffix}` : ''}`;
  },
}: EntryHandlers & { entry: Entry; selected: boolean; focused?: boolean; admin: boolean; fileUrlFor?: (entry: Entry, download: boolean, exportFormat?: string) => string }) {
  const { formatBytes, formatDate, t } = useI18n();
  const isFolder = entry.kind === 'folder';
  const selectable = admin && isEntryMutable(entry);
  const showActionMenu = admin || Boolean(entry.capabilities.download && entry.exportOptions?.length);
  const activate = () => (isFolder ? onOpen(entry) : onPreview(entry));
  const openLabel = `${t('action.open')} ${entry.name}`;
  const quickExport = entry.exportOptions?.find((option) => option.format === 'pdf') ?? entry.exportOptions?.[0];
  const downloadLabel = quickExport ? t('action.exportNamed', { format: quickExport.label, name: entry.name }) : `${t('action.download')} ${entry.name}`;

  return (
    <li
      id={`explorer-entry-${entry.id}`}
      data-entry-id={entry.id}
      tabIndex={-1}
      className={`entryRow${selected ? ' isSelected' : ''}${focused ? ' isFocused' : ''}`}
      onContextMenu={(event) => {
        if (!showActionMenu) return;
        event.preventDefault();
        const anchor = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button, a, input') ?? event.currentTarget : event.currentTarget;
        anchor.focus();
        onMenu(entry, anchor);
      }}
    >
      {selectable ? (
        <label className="entrySelect">
          <span className="srOnly">{t('entry.select', { name: entry.name })}</span>
          <input type="checkbox" checked={selected} onChange={(event) => onToggle(entry, { range: (event.nativeEvent as MouseEvent).shiftKey })} />
        </label>
      ) : <span className="entrySelectPlaceholder" aria-hidden="true" />}
      <button className="entryOpen" type="button" onClick={(event) => {
        if (selectable && (event.metaKey || event.ctrlKey || event.shiftKey)) onToggle(entry, { range: event.shiftKey });
        else activate();
      }} aria-label={openLabel}>
        <span className={`entryIcon ${isFolder ? 'folder' : 'file'}`}><FileIcon entry={entry} size={18} /></span>
        <span className="entryName">
          <strong title={entry.name}>{entry.name}</strong>
        </span>
      </button>
      <time className="entryDate" dateTime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
      <span className="entrySize">{isFolder ? '—' : formatBytes(entry.size)}</span>
      <span className="entryActions">
        {entry.capabilities.download ? <a className="iconButton" href={fileUrlFor(entry, true, quickExport?.format)} title={downloadLabel} aria-label={downloadLabel}><Download aria-hidden="true" size={16} /></a> : null}
        {showActionMenu ? (
          <button className="iconButton" type="button" title={t('entry.actions', { name: entry.name })} aria-label={t('entry.actions', { name: entry.name })} onClick={(event) => onMenu(entry, event.currentTarget)}>
            <MoreHorizontal aria-hidden="true" size={17} />
          </button>
        ) : null}
      </span>
    </li>
  );
}
