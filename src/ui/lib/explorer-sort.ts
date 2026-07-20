import type { Entry } from '../types/entries';

export type ExplorerSortField = 'name' | 'size' | 'updated';
export type ExplorerSortOrder = 'asc' | 'desc';

export interface ExplorerSort {
  field: ExplorerSortField;
  order: ExplorerSortOrder;
}

/** Folder-first compare used by the explorer list/grid. */
export function compareEntries(left: Entry, right: Entry, sort: ExplorerSort): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const direction = sort.order === 'asc' ? 1 : -1;
  let result = 0;
  if (sort.field === 'size') result = left.size - right.size;
  if (sort.field === 'updated') result = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  return (result || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })) * direction;
}

export function sortEntries(entries: readonly Entry[], sort: ExplorerSort): Entry[] {
  return entries.slice().sort((left, right) => compareEntries(left, right, sort));
}
