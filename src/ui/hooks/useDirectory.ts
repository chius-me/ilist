import { useCallback, useEffect, useRef, useState } from 'react';
import { listDirectory } from '../api/entries';
import type { DirectoryResponse } from '../types/entries';
import type { SessionStatus } from './useSession';

interface DirectoryState {
  data: DirectoryResponse | null;
  loading: boolean;
  error: Error | null;
}

export function useDirectory(path: string, sessionStatus: SessionStatus) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const manualRefresh = useRef(false);
  const [state, setState] = useState<DirectoryState>({ data: null, loading: sessionStatus === 'checking', error: null });

  useEffect(() => {
    if (sessionStatus === 'checking') return;

    const controller = new AbortController();
    const keepData = manualRefresh.current;
    manualRefresh.current = false;
    setState((current) => ({ data: keepData ? current.data : null, loading: true, error: null }));

    void listDirectory(path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error : new Error('Directory request failed'),
        }));
      });

    return () => controller.abort();
  }, [path, refreshVersion, sessionStatus]);

  const refresh = useCallback(() => {
    manualRefresh.current = true;
    setRefreshVersion((current) => current + 1);
  }, []);

  return { ...state, refresh };
}
