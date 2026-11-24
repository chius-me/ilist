import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, type HTMLAttributes } from 'react';
import { useVirtualWindow } from '../../hooks/useVirtualWindow';
import { useI18n } from '../../i18n/I18nProvider';
import type { Entry } from '../../types/entries';
import { EntryRow, type EntryHandlers } from './EntryRow';
import type { ExplorerSort, ExplorerSortField } from './ExplorerToolbar';

const LIST_ROW_HEIGHT = 36;

export function FileList({
  entries,
  selectedIds,
  admin,
  handlers,
  interactionProps,
  focusedId,
  fileUrlFor,
  sort,
  onSort,
  allSelected = false,
  someSelected = false,
  onToggleSelectAll,
}: {
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
  interactionProps?: HTMLAttributes<HTMLUListElement>;
  focusedId?: string | null;
  fileUrlFor?: (entry: Entry, download: boolean, exportFormat?: string) => string;
  sort?: ExplorerSort;
  onSort?: (sort: ExplorerSort) => void;
  allSelected?: boolean;
  someSelected?: boolean;
  onToggleSelectAll?: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const windowState = useVirtualWindow({ count: entries.length, itemHeight: LIST_ROW_HEIGHT, threshold: 100 });
  const visibleEntries = windowState.virtualized
    ? entries.slice(windowState.startIndex, windowState.endIndex)
    : entries;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = Boolean(someSelected && !allSelected);
    }
  }, [allSelected, someSelected]);

  function renderSortHeader(field: ExplorerSortField, label: string) {
    const active = sort?.field === field;
    if (!sort || !onSort) {
      return <span>{label}</span>;
    }
    const nextOrder = active && sort.order === 'asc' ? 'desc' : 'asc';
    return (
      <span>
        <button
          className={`fileListSortBtn${active ? ' isActive' : ''}`}
          type="button"
          aria-pressed={active}
          onClick={() => onSort({ field, order: nextOrder })}
        >
          <span>{label}</span>
          {active ? (
            sort.order === 'asc' ? <ArrowUp aria-hidden="true" size={12} /> : <ArrowDown aria-hidden="true" size={12} />
          ) : null}
        </button>
      </span>
    );
  }

  return (
    <div className="fileListFrame">
      <div className="fileListHeader">
        <span>
          {admin && onToggleSelectAll ? (
            <label className="entrySelect">
              <span className="srOnly">{t('explorer.selectAll')}</span>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={Boolean(allSelected)}
                onChange={(event) => onToggleSelectAll(event.target.checked)}
              />
            </label>
          ) : null}
        </span>
        {renderSortHeader('name', t('toolbar.name'))}
        {renderSortHeader('updated', t('toolbar.modified'))}
        {renderSortHeader('size', t('toolbar.size'))}
        <span>{t('mount.columnActions')}</span>
      </div>
      <ul className="fileList" aria-label={t('explorer.collection')} {...interactionProps}>
        {windowState.virtualized && windowState.paddingTop > 0 ? (
          <li className="virtualSpacer" aria-hidden="true" style={{ height: `${windowState.paddingTop}px` }} />
        ) : null}
        {visibleEntries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            selected={selectedIds.has(entry.id)}
            focused={focusedId === entry.id}
            admin={admin}
            fileUrlFor={fileUrlFor}
            {...handlers}
          />
        ))}
        {windowState.virtualized && windowState.paddingBottom > 0 ? (
          <li className="virtualSpacer" aria-hidden="true" style={{ height: `${windowState.paddingBottom}px` }} />
        ) : null}
      </ul>
    </div>
  );
}
