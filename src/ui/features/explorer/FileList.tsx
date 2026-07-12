import type { Entry } from '../../types/entries';
import { EntryRow, type EntryHandlers } from './EntryRow';

export function FileList({
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
    <ul className="fileList" aria-label="Files and folders">
      {entries.map((entry) => <EntryRow key={entry.id} entry={entry} selected={selectedIds.has(entry.id)} admin={admin} {...handlers} />)}
    </ul>
  );
}
