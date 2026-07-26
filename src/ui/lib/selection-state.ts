export interface SelectionState {
  selectedIds: Set<string>;
  anchorId: string | null;
}

export function emptySelection(): SelectionState {
  return { selectedIds: new Set(), anchorId: null };
}

export function toggleSelection(state: SelectionState, id: string): SelectionState {
  const next = new Set(state.selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { selectedIds: next, anchorId: id };
}

export function rangeSelection(state: SelectionState, orderedIds: string[], targetId: string): SelectionState {
  const anchor = state.anchorId && orderedIds.includes(state.anchorId) ? state.anchorId : targetId;
  const start = orderedIds.indexOf(anchor);
  const end = orderedIds.indexOf(targetId);
  if (start === -1 || end === -1) return { selectedIds: new Set(state.selectedIds), anchorId: targetId };
  const next = new Set(state.selectedIds);
  for (const id of orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(id);
  return { selectedIds: next, anchorId: anchor };
}

export function selectAllSelection(state: SelectionState, ids: Iterable<string>): SelectionState {
  const selectedIds = new Set(ids);
  const anchorId = state.anchorId && selectedIds.has(state.anchorId)
    ? state.anchorId
    : (selectedIds.values().next().value ?? null);
  return { selectedIds, anchorId };
}

export function replaceSelection(ids: Iterable<string>): SelectionState {
  const selectedIds = new Set(ids);
  return { selectedIds, anchorId: selectedIds.values().next().value ?? null };
}
