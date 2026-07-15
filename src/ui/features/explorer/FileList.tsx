import type { HTMLAttributes } from 'react';
import type { Entry } from '../../types/entries';
import { EntryRow, type EntryHandlers } from './EntryRow';

export function FileList({
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
  return (
    <div className="fileListFrame">
      <div className="fileListHeader" aria-hidden="true">
        <span />
        <span>Name</span>
        <span>Modified</span>
        <span>Size</span>
        <span>Actions</span>
      </div>
      <ul className="fileList" aria-label="Files and folders" {...interactionProps}>
        {entries.map((entry) => <EntryRow key={entry.id} entry={entry} selected={selectedIds.has(entry.id)} focused={focusedId === entry.id} admin={admin} {...handlers} />)}
      </ul>
    </div>
  );
}
