import { useCallback, useState } from 'react';

export function useSelection() {
  const [state, setState] = useState<{ selectedIds: Set<string>; anchorId: string | null }>(() => ({ selectedIds: new Set(), anchorId: null }));

  const toggle = useCallback((id: string) => {
    setState((current) => {
      const next = new Set(current.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next, anchorId: id };
    });
  }, []);

  const range = useCallback((orderedIds: string[], targetId: string) => {
    setState((current) => {
      const anchor = current.anchorId && orderedIds.includes(current.anchorId) ? current.anchorId : targetId;
      const start = orderedIds.indexOf(anchor);
      const end = orderedIds.indexOf(targetId);
      const next = new Set(current.selectedIds);
      for (const id of orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(id);
      return { selectedIds: next, anchorId: anchor };
    });
  }, []);

  const selectAll = useCallback((ids: Iterable<string>) => {
    setState((current) => {
      const selectedIds = new Set(ids);
      const anchorId = current.anchorId && selectedIds.has(current.anchorId) ? current.anchorId : (selectedIds.values().next().value ?? null);
      return { selectedIds, anchorId };
    });
  }, []);

  const replace = useCallback((ids: Iterable<string>) => {
    setState(() => {
      const selectedIds = new Set(ids);
      return { selectedIds, anchorId: selectedIds.values().next().value ?? null };
    });
  }, []);

  const clear = useCallback(() => {
    setState({ selectedIds: new Set(), anchorId: null });
  }, []);

  return { selectedIds: state.selectedIds, anchorId: state.anchorId, toggle, range, selectAll, replace, clear };
}
