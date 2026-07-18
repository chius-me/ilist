import type { HTMLAttributes } from 'react';
import type { Entry } from '../../types/entries';
import { useI18n } from '../../i18n/I18nProvider';
import { EntryRow, type EntryHandlers } from './EntryRow';

export function FileList({
  entries,
  selectedIds,
  admin,
  handlers,
  interactionProps,
  focusedId,
  fileUrlFor,
}: {
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
  interactionProps?: HTMLAttributes<HTMLUListElement>;
  focusedId?: string | null;
  fileUrlFor?: (entry: Entry, download: boolean) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="fileListFrame">
      <div className="fileListHeader" aria-hidden="true">
        <span />
        <span>{t('toolbar.name')}</span>
        <span>{t('toolbar.modified')}</span>
        <span>{t('toolbar.size')}</span>
        <span>{t('mount.columnActions')}</span>
      </div>
      <ul className="fileList" aria-label={t('explorer.collection')} {...interactionProps}>
        {entries.map((entry) => <EntryRow key={entry.id} entry={entry} selected={selectedIds.has(entry.id)} focused={focusedId === entry.id} admin={admin} fileUrlFor={fileUrlFor} {...handlers} />)}
      </ul>
    </div>
  );
}
