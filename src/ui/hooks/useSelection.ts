import { useCallback, useState } from 'react';
import {
  emptySelection,
  rangeSelection,
  replaceSelection,
  selectAllSelection,
  toggleSelection,
} from '../lib/selection-state';

export function useSelection() {
  const [state, setState] = useState(emptySelection);

  const toggle = useCallback((id: string) => {
    setState((current) => toggleSelection(current, id));
  }, []);

  const range = useCallback((orderedIds: string[], targetId: string) => {
    setState((current) => rangeSelection(current, orderedIds, targetId));
  }, []);

  const selectAll = useCallback((ids: Iterable<string>) => {
    setState((current) => selectAllSelection(current, ids));
  }, []);

  const replace = useCallback((ids: Iterable<string>) => {
    setState(() => replaceSelection(ids));
  }, []);

  const clear = useCallback(() => {
    setState(emptySelection());
  }, []);

  return { selectedIds: state.selectedIds, anchorId: state.anchorId, toggle, range, selectAll, replace, clear };
}
