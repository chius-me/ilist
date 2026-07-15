import type { Entry } from '../../types/entries';
import type { ExplorerView } from './ExplorerToolbar';
import { FileGrid } from './FileGrid';
import { FileList } from './FileList';
import type { EntryHandlers } from './EntryRow';

export interface ExplorerCollectionProps {
  view: ExplorerView;
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
}

export function ExplorerCollection({ view, entries, selectedIds, admin, handlers }: ExplorerCollectionProps) {
  return view === 'list'
    ? <FileList entries={entries} selectedIds={selectedIds} admin={admin} handlers={handlers} />
    : <FileGrid entries={entries} selectedIds={selectedIds} admin={admin} handlers={handlers} />;
}
