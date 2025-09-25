import { AlertCircle, Folder, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { childPath, getEntry } from '../api/entries';
import { useDirectory } from '../hooks/useDirectory';
import { useExplorerLocation } from '../hooks/useExplorerLocation';
import { useSelection } from '../hooks/useSelection';
import { useSession } from '../hooks/useSession';
import type { Entry } from '../types/entries';
import { Breadcrumbs } from '../features/explorer/Breadcrumbs';
import { EmptyState } from '../features/explorer/EmptyState';
import { FileGrid } from '../features/explorer/FileGrid';
import { FileList } from '../features/explorer/FileList';
import { ExplorerToolbar, type ExplorerSort, type ExplorerView } from '../features/explorer/ExplorerToolbar';
import { LoginDialog } from '../features/explorer/LoginDialog';
import { PreviewOverlay } from '../features/preview/PreviewOverlay';

const VIEW_MODE_KEY = 'ilist.explorer.view';

function storedViewMode(): ExplorerView {
  try {
    return window.localStorage?.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

function persistViewMode(view: ExplorerView): void {
  try {
    window.localStorage?.setItem(VIEW_MODE_KEY, view);
  } catch {
    // Storage can be unavailable in embedded and privacy-restricted browsers.
  }
}

function compareEntries(left: Entry, right: Entry, sort: ExplorerSort): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const direction = sort.order === 'asc' ? 1 : -1;
  let result = 0;
  if (sort.field === 'size') result = left.size - right.size;
  if (sort.field === 'updated') result = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  return (result || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })) * direction;
}

function LoadingRows() {
  return (
    <div className="loadingRows" aria-label="Loading files" aria-busy="true">
      {[0, 1, 2, 3, 4].map((row) => <div className="loadingRow" key={row}><span /><span /><span /></div>)}
    </div>
  );
}

export function ExplorerApp() {
  const { path, previewId, openPath, openPreview, closePreview } = useExplorerLocation();
  const session = useSession();
  const lastNonAdminPath = useRef('/');
  const explorerPath = path === '/admin' ? lastNonAdminPath.current : path;
  const directory = useDirectory(explorerPath, session.status);
  const selection = useSelection();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ExplorerSort>({ field: 'name', order: 'asc' });
  const [view, setView] = useState<ExplorerView>(storedViewMode);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<Entry | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<Error | null>(null);

  useEffect(() => {
    if (path !== '/admin') lastNonAdminPath.current = path;
  }, [path]);

  useEffect(() => {
    persistViewMode(view);
  }, [view]);

  useEffect(() => {
    if (!previewId) {
      setPreviewEntry(null);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    setPreviewEntry(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void getEntry(previewId, controller.signal).then(setPreviewEntry).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setPreviewError(error instanceof Error ? error : new Error('Unable to load preview'));
    }).finally(() => {
      if (!controller.signal.aborted) setPreviewLoading(false);
    });
    return () => controller.abort();
  }, [previewId]);

  useEffect(() => {
    selection.clear();
    setQuery('');
  }, [explorerPath, selection.clear]);

  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (directory.data?.items ?? [])
      .filter((entry) => !needle || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => compareEntries(left, right, sort));
  }, [directory.data, query, sort]);

  const admin = session.status === 'admin';
  const handlers = {
    onOpen: (entry: Entry) => openPath(childPath(explorerPath, entry.name)),
    onPreview: (entry: Entry) => openPreview(entry.id),
    onToggle: (entry: Entry) => selection.toggle(entry.id),
    onMenu: (_entry: Entry) => undefined,
  };

  async function submitLogin(username: string, password: string) {
    setLoginBusy(true);
    setLoginError(null);
    try {
      await session.signIn(username, password);
      openPath(lastNonAdminPath.current);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Unable to sign in');
    } finally {
      setLoginBusy(false);
    }
  }

  function closeLogin() {
    setLoginError(null);
    openPath(lastNonAdminPath.current);
  }

  return (
    <>
      <a className="skipLink" href="#file-explorer">Skip to files</a>
      <header className="siteHeader">
        <div className="headerInner">
          <button className="siteName" type="button" onClick={() => openPath('/')} aria-label="Open ilist root"><Folder aria-hidden="true" size={19} />ilist</button>
          <span className="sessionIndicator">{admin ? session.user?.username || 'Admin' : 'Shared files'}</span>
        </div>
      </header>
      <main className="explorerShell" id="file-explorer">
        {directory.data ? <Breadcrumbs items={directory.data.breadcrumbs} onOpen={openPath} /> : <div className="breadcrumbPlaceholder" aria-hidden="true" />}
        <ExplorerToolbar
          query={query}
          sort={sort}
          view={view}
          sessionStatus={session.status}
          selectionCount={selection.selectedIds.size}
          onQuery={setQuery}
          onSort={setSort}
          onView={setView}
          onLogin={() => openPath('/admin')}
          onUpload={() => undefined}
          onCreateFolder={() => undefined}
        />
        <section className="explorerContent" aria-label={previewId ? `Files with preview ${previewId} selected` : 'Files'}>
          {directory.error && directory.data ? (
            <div className="retryBanner" role="alert">
              <AlertCircle aria-hidden="true" size={18} />
              <span>{directory.error.message}</span>
              <button type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={15} />Retry</button>
            </div>
          ) : null}
          {directory.loading && !directory.data ? <LoadingRows /> : null}
          {directory.error && !directory.data ? (
            <div className="errorState" role="alert">
              <AlertCircle aria-hidden="true" size={32} />
              <strong>Unable to load this folder</strong>
              <span>{directory.error.message}</span>
              <button className="button" type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={16} />Retry</button>
            </div>
          ) : null}
          {directory.data && !directory.loading && !directory.error && entries.length === 0 ? <EmptyState query={query} admin={admin} /> : null}
          {directory.data && entries.length > 0 ? (view === 'list' ? <FileList entries={entries} selectedIds={selection.selectedIds} admin={admin} handlers={handlers} /> : <FileGrid entries={entries} selectedIds={selection.selectedIds} admin={admin} handlers={handlers} />) : null}
          {directory.loading && directory.data ? <div className="refreshing" role="status"><LoaderCircle aria-hidden="true" size={16} />Refreshing</div> : null}
        </section>
      </main>
      <LoginDialog open={path === '/admin' && session.status !== 'admin'} busy={loginBusy} error={loginError} onClose={closeLogin} onSubmit={submitLogin} />
      {previewId ? <PreviewOverlay entry={previewEntry} loading={previewLoading} error={previewError} onClose={closePreview} /> : null}
    </>
  );
}
