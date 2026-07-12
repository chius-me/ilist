import { useCallback, useState } from 'react';

export function useSelection() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: Iterable<string>) => {
    setSelectedIds(() => new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const replace = useCallback((ids: Iterable<string>) => {
    setSelectedIds(new Set(ids));
  }, []);

  return { selectedIds, toggle, selectAll, clear, replace };
}
