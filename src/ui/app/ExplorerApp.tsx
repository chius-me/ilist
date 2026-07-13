import { AlertCircle, Folder, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { childPath, createFolder, deleteEntries, getEntry, moveEntries, patchEntry, setVisibility } from '../api/entries';
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
import { entryActions, EntryActionMenu, type EntryActionId } from '../features/explorer/EntryActionMenu';
import { MobileActionSheet } from '../features/explorer/MobileActionSheet';
import { SelectionToolbar } from '../features/explorer/SelectionToolbar';
import { LoginDialog } from '../features/explorer/LoginDialog';
import { DeleteDialog } from '../features/operations/DeleteDialog';
import { FolderPickerDialog } from '../features/operations/FolderPickerDialog';
import { PropertiesDialog } from '../features/operations/PropertiesDialog';
import { RenameDialog } from '../features/operations/RenameDialog';
import { PreviewOverlay } from '../features/preview/PreviewOverlay';
import { UploadPanel } from '../features/uploads/UploadPanel';
import { useUploadQueue } from '../features/uploads/useUploadQueue';

const VIEW_MODE_KEY = 'ilist.explorer.view';
const MOBILE_ACTIONS_QUERY = '(max-width: 760px)';

function useMobileActions() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_ACTIONS_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_ACTIONS_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return mobile;
}

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
  const [menuEntry, setMenuEntry] = useState<Entry | null>(null);
  const [dialog, setDialog] = useState<{ type: 'rename' | 'create' | 'move' | 'delete' | 'properties'; entries: Entry[] } | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const mobileActions = useMobileActions();

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
    setMenuEntry(null);
  }, [explorerPath, selection.clear]);

  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (directory.data?.items ?? [])
      .filter((entry) => !needle || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => compareEntries(left, right, sort));
  }, [directory.data, query, sort]);

  const admin = session.status === 'admin';
  const uploads = useUploadQueue({
    canUpload: admin,
    existingNames: directory.data?.items.map((entry) => entry.name) ?? [],
    onCompleted: (parentId) => {
      if (directory.data?.current.id === parentId) directory.refresh();
    },
  });
  const handlers = {
    onOpen: (entry: Entry) => openPath(childPath(explorerPath, entry.name)),
    onPreview: (entry: Entry) => openPreview(entry.id),
    onToggle: (entry: Entry) => selection.toggle(entry.id),
    onMenu: (entry: Entry) => setMenuEntry(entry),
  };

  const selectedEntries = entries.filter((entry) => selection.selectedIds.has(entry.id));

  function enqueueFiles(files: File[]) {
    if (directory.data) uploads.enqueue(directory.data.current.id, files);
  }

  function acceptsFiles(event: DragEvent<HTMLElement>): boolean {
    return admin && Array.from(event.dataTransfer.types).includes('Files');
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (acceptsFiles(event)) event.preventDefault();
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!acceptsFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragOver(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    enqueueFiles(Array.from(event.dataTransfer.files));
  }
  async function runBatch(operation: () => Promise<{ succeeded: string[]; failed: { id: string }[] }>) {
    setOperationPending(true); setOperationNotice(null);
    try {
      const result = await operation();
      if (result.failed.length) {
        selection.replace(result.failed.map((failure) => failure.id));
        setOperationNotice(`${result.succeeded.length} completed, ${result.failed.length} failed`);
      } else {
        selection.clear();
        setOperationNotice(`${result.succeeded.length} completed`);
      }
      directory.refresh();
    } catch (error) { setOperationNotice(error instanceof Error ? error.message : 'Operation failed.'); throw error; } finally { setOperationPending(false); }
  }

  function openEntryAction(action: EntryActionId, entry: Entry) {
    if (action === 'rename' || action === 'properties' || action === 'move' || action === 'delete') setDialog({ type: action, entries: [entry] });
    if (action === 'publish' || action === 'hide') void runBatch(() => setVisibility([entry.id], action === 'publish'));
  }

  const currentEntryActions = menuEntry ? entryActions(menuEntry, { onOpen: handlers.onOpen, onPreview: handlers.onPreview, onAction: openEntryAction }) : [];

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
      <a className="skipLink" href="#file-list">Skip to files</a>
      <header className="siteHeader">
        <div className="headerInner">
          <button className="siteName" type="button" onClick={() => openPath('/')} aria-label="Open ilist root"><Folder aria-hidden="true" size={19} />ilist</button>
          <span className="sessionIndicator">{admin ? session.user?.username || 'Admin' : 'Shared files'}</span>
        </div>
      </header>
      <main className="explorerShell" id="file-explorer">
        {directory.data ? <Breadcrumbs items={directory.data.breadcrumbs} onOpen={openPath} /> : <div className="breadcrumbPlaceholder" aria-hidden="true" />}
        {admin && selection.selectedIds.size > 0 ? <SelectionToolbar count={selection.selectedIds.size} pending={operationPending} onMove={() => setDialog({ type: 'move', entries: selectedEntries })} onPublish={() => void runBatch(() => setVisibility(selectedEntries.map((entry) => entry.id), true))} onHide={() => void runBatch(() => setVisibility(selectedEntries.map((entry) => entry.id), false))} onDelete={() => setDialog({ type: 'delete', entries: selectedEntries })} onClear={selection.clear} /> : <ExplorerToolbar
          query={query}
          sort={sort}
          view={view}
          sessionStatus={session.status}
          selectionCount={selection.selectedIds.size}
          onQuery={setQuery}
          onSort={setSort}
          onView={setView}
          onLogin={() => openPath('/admin')}
          onUpload={enqueueFiles}
          onCreateFolder={() => setDialog({ type: 'create', entries: [] })}
        />}
        <section className={`explorerContent${dragOver ? ' isDragOver' : ''}`} id="file-list" tabIndex={-1} aria-label={previewId ? `Files with preview ${previewId} selected` : 'Files'} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
          {directory.error && directory.data ? (
            <div className="retryBanner" role="alert">
              <AlertCircle aria-hidden="true" size={18} />
              <span>{directory.error.message}</span>
              <button type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={15} />Retry</button>
            </div>
          ) : null}
          {operationNotice ? <div className="operationNotice" role="status" aria-live="polite">{operationNotice}</div> : null}
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
      <UploadPanel tasks={uploads.tasks} onCancel={uploads.cancel} onRetry={uploads.retry} onRemove={uploads.remove} onClearCompleted={uploads.clearCompleted} />
      <LoginDialog open={path === '/admin' && session.status !== 'admin'} busy={loginBusy} error={loginError} onClose={closeLogin} onSubmit={submitLogin} />
      {menuEntry && !mobileActions ? <EntryActionMenu entry={menuEntry} actions={currentEntryActions} onClose={() => setMenuEntry(null)} /> : null}
      {menuEntry && mobileActions ? <MobileActionSheet open title={`Actions for ${menuEntry.name}`} actions={currentEntryActions} onClose={() => setMenuEntry(null)} /> : null}
      {dialog?.type === 'rename' ? <RenameDialog open title={`Rename ${dialog.entries[0].name}`} initialName={dialog.entries[0].name} onClose={() => setDialog(null)} onSubmit={async (name) => { await patchEntry(dialog.entries[0].id, { name }); directory.refresh(); }} /> : null}
      {dialog?.type === 'create' && directory.data ? <RenameDialog open title="Create folder" submitLabel="Create" onClose={() => setDialog(null)} onSubmit={async (name) => { await createFolder(directory.data!.current.id, name); directory.refresh(); }} /> : null}
      {dialog?.type === 'move' ? <FolderPickerDialog entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={(destinationId) => runBatch(() => moveEntries(dialog.entries.map((entry) => entry.id), destinationId))} /> : null}
      {dialog?.type === 'delete' ? <DeleteDialog entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={() => runBatch(() => deleteEntries(dialog.entries.map((entry) => entry.id)))} /> : null}
      {dialog?.type === 'properties' ? <PropertiesDialog entry={dialog.entries[0]} onClose={() => setDialog(null)} onSubmit={async (patch) => { await patchEntry(dialog.entries[0].id, patch); directory.refresh(); }} /> : null}
      {previewId ? <PreviewOverlay entry={previewEntry} loading={previewLoading} error={previewError} onClose={closePreview} /> : null}
    </>
  );
}
