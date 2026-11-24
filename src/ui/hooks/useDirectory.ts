import { useCallback, useEffect, useRef, useState } from 'react';
import { listDirectory } from '../api/entries';
import { DirectoryCache } from '../lib/directory-cache';
import { normalizeDirectoryQuery } from '../lib/directory-query';
import type { DirectoryResponse, Entry } from '../types/entries';
import type { SessionStatus } from './useSession';

interface DirectoryState {
  data: DirectoryResponse | null;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
}

const directoryCache = new DirectoryCache<DirectoryResponse>(30, 30_000);

export function clearDirectoryCache(): void {
  directoryCache.clear();
}

function mergeUniqueEntries(existing: readonly Entry[], incoming: readonly Entry[]): Entry[] {
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = existing.slice();
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

export function useDirectory(path: string, sessionStatus: SessionStatus, nameFilter = '') {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const settledSession = useRef<'guest' | 'admin' | null>(null);
  const manualRefresh = useRef(false);
  const previousPath = useRef(path);
  const loadMoreController = useRef<AbortController | null>(null);
  const latestSessionStatus = useRef(sessionStatus);
  latestSessionStatus.current = sessionStatus;
  const [state, setState] = useState<DirectoryState>({
    data: null,
    loading: true,
    loadingMore: false,
    error: null,
  });

  useEffect(() => {
    if (sessionStatus === 'checking') return;
    if (settledSession.current === null) {
      settledSession.current = sessionStatus;
      return;
    }
    if (settledSession.current !== sessionStatus) {
      settledSession.current = sessionStatus;
      clearDirectoryCache();
      setSessionEpoch((current) => current + 1);
    }
  }, [sessionStatus]);

  useEffect(() => {
    void refreshVersion;
    void sessionEpoch;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    const controller = new AbortController();
    const normalizedFilter = normalizeDirectoryQuery(nameFilter);
    const bypassEdgeCache = manualRefresh.current;
    const sessionScope = latestSessionStatus.current;
    const canUseCache = !normalizedFilter && !bypassEdgeCache && sessionScope !== 'checking';
    const cacheKey = `${sessionScope}:${path}`;

    if (canUseCache) {
      const cached = directoryCache.get(cacheKey);
      if (cached) {
        previousPath.current = path;
        setState({ data: cached, loading: false, loadingMore: false, error: null });
        return () => {
          controller.abort();
        };
      }
    }

    if (bypassEdgeCache) {
      clearDirectoryCache();
    }

    // Keep listing visible for same-path search/refresh; only clear on navigation.
    const keepData = bypassEdgeCache || previousPath.current === path;
    manualRefresh.current = false;
    previousPath.current = path;
    setState((current) => ({
      data: keepData ? current.data : null,
      loading: true,
      loadingMore: false,
      error: null,
    }));

    void listDirectory(
      path,
      controller.signal,
      normalizedFilter,
      bypassEdgeCache ? { refresh: true } : undefined,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          if (!normalizedFilter && latestSessionStatus.current !== 'checking') {
            directoryCache.set(`${latestSessionStatus.current}:${path}`, data);
          }
          setState({ data, loading: false, loadingMore: false, error: null });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setState((current) => ({
          ...current,
          loading: false,
          loadingMore: false,
          error: error instanceof Error ? error : new Error('Directory request failed'),
        }));
      });

    return () => {
      controller.abort();
      loadMoreController.current?.abort();
      loadMoreController.current = null;
    };
  }, [nameFilter, path, refreshVersion, sessionEpoch]);

  const refresh = useCallback(() => {
    clearDirectoryCache();
    manualRefresh.current = true;
    setRefreshVersion((current) => current + 1);
  }, []);

  const applyLocalUpdate = useCallback((updater: (current: DirectoryResponse) => DirectoryResponse) => {
    clearDirectoryCache();
    setState((current) => (current.data ? { ...current, data: updater(current.data) } : current));
  }, []);

  const loadMore = useCallback(() => {
    const nextCursor = state.data?.nextCursor;
    if (!nextCursor || state.loading || state.loadingMore) return;
    loadMoreController.current?.abort();
    const controller = new AbortController();
    loadMoreController.current = controller;
    setState((current) => ({ ...current, loadingMore: true, error: null }));

    void listDirectory(path, controller.signal, normalizeDirectoryQuery(nameFilter), { cursor: nextCursor })
      .then((nextPage) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          data: current.data
            ? {
                ...current.data,
                items: mergeUniqueEntries(current.data.items, nextPage.items),
                nextCursor: nextPage.nextCursor ?? null,
              }
            : nextPage,
          loading: false,
          loadingMore: false,
          error: null,
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setState((current) => ({
          ...current,
          loadingMore: false,
          error: error instanceof Error ? error : new Error('Directory request failed'),
        }));
      });
  }, [nameFilter, path, state.data?.nextCursor, state.loading, state.loadingMore]);

  return {
    data: state.data,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: Boolean(state.data?.nextCursor),
    error: state.error,
    refresh,
    applyLocalUpdate,
    loadMore,
  };
}
