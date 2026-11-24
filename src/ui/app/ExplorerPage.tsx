import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { copyEntries, createFolder, deleteEntries, entryPath, getEntry, moveEntries, patchEntry, setVisibility } from '../api/entries';
import { createShare } from '../api/shares';
import { ToastRegion, type ToastMessage, type ToastTone } from '../components/ToastRegion';
import { EmptyState } from '../features/explorer/EmptyState';
import { entryActions, EntryActionMenu, type EntryActionId } from '../features/explorer/EntryActionMenu';
import type { EntryHandlers } from '../features/explorer/EntryRow';
import { ExplorerCollection } from '../features/explorer/ExplorerCollection';
import { ExplorerToolbar, type ExplorerSort, type ExplorerView } from '../features/explorer/ExplorerToolbar';
import { MobileActionSheet, useMobileActions } from '../features/explorer/MobileActionSheet';
import { SelectionToolbar } from '../features/explorer/SelectionToolbar';
import type { EnqueueUploadOptions } from '../features/uploads/useUploadQueue';
import { useDirectory, clearDirectoryCache } from '../hooks/useDirectory';
import { useSelection } from '../hooks/useSelection';
import type { useSession } from '../hooks/useSession';
import { useI18n } from '../i18n/I18nProvider';
import { localizedApiError } from '../i18n/apiErrors';
import { scheduleDeferredFeedback } from '../lib/deferred-feedback';
import { directoryErrorHint, directoryErrorTitle } from '../lib/directory-errors';
import { DIRECTORY_QUERY_DEBOUNCE_MS, normalizeDirectoryQuery } from '../lib/directory-query';
import { sortEntries } from '../lib/explorer-sort';
import { enqueueFolderUpload, extractDroppedFiles, type RelativeUploadFile } from '../lib/folder-upload';
import { usePreferences } from '../preferences/PreferencesProvider';
import { isEntryMutable, type Entry } from '../types/entries';

const DeleteDialog = lazy(() => import('../features/operations/DeleteDialog').then((module) => ({ default: module.DeleteDialog })));
const FolderPickerDialog = lazy(() => import('../features/operations/FolderPickerDialog').then((module) => ({ default: module.FolderPickerDialog })));
const PropertiesDialog = lazy(() => import('../features/operations/PropertiesDialog').then((module) => ({ default: module.PropertiesDialog })));
const RenameDialog = lazy(() => import('../features/operations/RenameDialog').then((module) => ({ default: module.RenameDialog })));
const PreviewOverlay = lazy(() => import('../features/preview/PreviewOverlay').then((module) => ({ default: module.PreviewOverlay })));
const ShareDialog = lazy(() => import('../features/shares/ShareDialog').then((module) => ({ default: module.ShareDialog })));

function LoadingCollection({ view, label }: { view: ExplorerView; label: string }) {
  if (view === 'grid') {
    return <div className="loadingGrid" role="status" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((card) => <div className="loadingCard" key={card}><span /><span /><span /></div>)}
    </div>;
  }
  return (
    <div className="loadingRows" role="status" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3, 4].map((row) => <div className="loadingRow" key={row}><span /><span /><span /></div>)}
    </div>
  );
}

export interface ExplorerPageProps {
  path: string;
  previewId: string | null;
  session: ReturnType<typeof useSession>;
  suppressSessionError?: boolean;
  onEnqueueUpload?: (parentId: string, files: File[], options?: EnqueueUploadOptions) => void;
  onSubscribeUploadCompleted?: (listener: (parentId: string) => void) => () => void;
  onOpenPath(path: string): void;
  onOpenPreview(id: string): void;
  onClosePreview(): void;
  onRequestLogin(): void;
}

export function ExplorerPage({
  path,
  previewId,
  session,
  suppressSessionError = false,
  onEnqueueUpload,
  onSubscribeUploadCompleted,
  onOpenPath,
  onOpenPreview,
  onClosePreview,
}: ExplorerPageProps) {
  const selection = useSelection();
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const { preferences, updatePreferences } = usePreferences();
  const view: ExplorerView = preferences.defaultView;
  const [query, setQuery] = useState('');
  const [serverQuery, setServerQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const directory = useDirectory(path, session.status, serverQuery);
  const [sort, setSort] = useState<ExplorerSort>({ field: 'name', order: 'asc' });
  const [previewEntry, setPreviewEntry] = useState<Entry | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const [menu, setMenu] = useState<{ entry: Entry; anchor: HTMLElement | null } | null>(null);
  const [dialog, setDialog] = useState<{ type: 'rename' | 'create' | 'move' | 'copy' | 'delete' | 'properties' | 'share'; entries: Entry[] } | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSequence = useRef(0);
  const reportedSessionError = useRef<Error | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const mobileActions = useMobileActions();
  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const pushToast = useCallback((tone: ToastTone, message: string) => {
    toastSequence.current += 1;
    setToasts((current) => [...current, { id: `toast-${toastSequence.current}`, tone, message }].slice(-4));
  }, []);

  useEffect(() => {
    if (suppressSessionError || !session.error) {
      if (!session.error) reportedSessionError.current = null;
      return;
    }
    if (reportedSessionError.current === session.error) return;
    reportedSessionError.current = session.error;
    pushToast('error', localizedApiError(session.error, tRef.current, 'feedback.sessionError'));
  }, [pushToast, session.error, suppressSessionError]);

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
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setPreviewError(new Error(localizedApiError(error, tRef.current, 'preview.unavailable')));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setPreviewLoading(false);
    });
    return () => controller.abort();
  }, [previewId]);

  useEffect(() => {
    void path;
    selection.clear();
    setQuery('');
    setServerQuery('');
    setSearchOpen(false);
    setMenu(null);
  }, [path, selection.clear]);

  useEffect(() => {
    const normalized = normalizeDirectoryQuery(query);
    if (!normalized) {
      if (!serverQuery) return;
      const clearHandle = window.setTimeout(() => setServerQuery(''), DIRECTORY_QUERY_DEBOUNCE_MS);
      return () => window.clearTimeout(clearHandle);
    }
    if (!directory.hasMore && !serverQuery) return;
    const handle = window.setTimeout(
      () => setServerQuery(normalized),
      DIRECTORY_QUERY_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(handle);
  }, [directory.hasMore, query, serverQuery]);

  const currentFolderId = directory.data?.current.id;
  const refreshDirectory = directory.refresh;
  useEffect(() => {
    if (!onSubscribeUploadCompleted) return;
    return onSubscribeUploadCompleted((parentId) => {
      clearDirectoryCache();
      if (currentFolderId === parentId) refreshDirectory();
    });
  }, [currentFolderId, onSubscribeUploadCompleted, refreshDirectory]);

  useEffect(() => {
    if (previewEntry?.name) {
      document.title = `${previewEntry.name} · iList`;
      return;
    }
    const currentName = directory.data?.current.name;
    document.title = path === '/' || !currentName || currentName === 'iList'
      ? 'iList'
      : `${currentName} · iList`;
  }, [directory.data?.current.name, path, previewEntry?.name]);

  const normalizedQuery = normalizeDirectoryQuery(query);
  const entries = useMemo(() => {
    const items = directory.data?.items ?? [];
    const filtered = normalizedQuery && !serverQuery
      ? items.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery.toLowerCase()))
      : items;
    return sortEntries(filtered, sort);
  }, [directory.data, normalizedQuery, serverQuery, sort]);

  const admin = session.status === 'admin';
  const mutableVisibleIds = useMemo(() => admin ? entries.filter(isEntryMutable).map((entry) => entry.id) : [], [admin, entries]);
  const allSelected = mutableVisibleIds.length > 0 && mutableVisibleIds.every((id) => selection.selectedIds.has(id));
  const someSelected = mutableVisibleIds.some((id) => selection.selectedIds.has(id));
  const canUpload = admin && directory.data?.current.capabilities.upload === true;
  const canCreateFolder = admin && directory.data?.current.capabilities.createFolder === true;
  const breadcrumbs = directory.data?.breadcrumbs ?? [];
  const handlers: EntryHandlers = {
    onOpen: (entry) => onOpenPath(entryPath(path, entry)),
    onPreview: (entry) => onOpenPreview(entry.id),
    onToggle: (entry, options) => {
      if (!isEntryMutable(entry)) return;
      if (options?.range) selection.range(mutableVisibleIds, entry.id);
      else selection.toggle(entry.id);
    },
    onMenu: (entry, anchor) => setMenu({ entry, anchor: anchor ?? null }),
    folderHrefFor: (entry) => entryPath(path, entry),
  };

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (previewId || dialog || menu || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        if (selection.selectedIds.size > 0) {
          event.preventDefault();
          selection.clear();
        } else if (query) {
          event.preventDefault();
          setQuery('');
          setSearchOpen(false);
        }
        return;
      }
      if (event.key === 'Backspace' && path !== '/' && breadcrumbs.length >= 2) {
        event.preventDefault();
        onOpenPath(breadcrumbs[breadcrumbs.length - 2]!.path);
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [breadcrumbs, dialog, menu, onOpenPath, path, previewId, query, selection]);
  const selectedEntries = entries.filter((entry) => selection.selectedIds.has(entry.id) && isEntryMutable(entry));
  const selectionCapabilities = useMemo(() => ({
    canMove: selectedEntries.length > 0 && selectedEntries.every((entry) => entry.capabilities.move),
    canCopy: selectedEntries.length > 0 && selectedEntries.every((entry) => entry.capabilities.copy),
    canPublish: selectedEntries.length > 0 && selectedEntries.every((entry) => entry.capabilities.changeVisibility),
    canHide: selectedEntries.length > 0 && selectedEntries.every((entry) => entry.capabilities.changeVisibility),
    canDelete: selectedEntries.length > 0 && selectedEntries.every((entry) => entry.capabilities.delete),
  }), [selectedEntries]);

  function enqueueFilesFor(parentId: string, files: File[]) {
    if (directory.data && canUpload && onEnqueueUpload) {
      onEnqueueUpload(parentId, files, {
        canUpload,
        multipartUpload: directory.data.current.capabilities.multipartUpload === true,
        existingNames: parentId === directory.data.current.id ? directory.data.items.map((entry) => entry.name) : [],
      });
    }
  }

  function enqueueFiles(files: File[]) {
    if (directory.data) {
      enqueueFilesFor(directory.data.current.id, files);
    }
  }

  async function uploadRelativeFiles(items: RelativeUploadFile[]) {
    if (!directory.data || !canUpload || !onEnqueueUpload || items.length === 0) return;
    try {
      const outcome = await enqueueFolderUpload(items, directory.data.current.id, {
        createFolder,
        existingEntries: directory.data.items,
        enqueueFiles: enqueueFilesFor,
      });
      if (outcome.foldersCreated > 0) {
        directory.refresh();
      }
    } catch (error) {
      pushToast('error', localizedApiError(error, t, 'feedback.operationFailed'));
    }
  }

  function acceptsFiles(event: DragEvent<HTMLElement>): boolean {
    return canUpload && Array.from(event.dataTransfer.types).includes('Files');
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
    const plainFiles = Array.from(event.dataTransfer.files);
    const hasDirectoryEntry = Array.from(event.dataTransfer.items ?? []).some(
      (item) => typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory === true,
    );
    if (hasDirectoryEntry) {
      void extractDroppedFiles(event.dataTransfer)
        .then(({ files }) => uploadRelativeFiles(files))
        .catch((error: unknown) => pushToast('error', localizedApiError(error, t, 'feedback.operationFailed')));
      return;
    }
    enqueueFiles(plainFiles);
  }

  async function runBatch(
    operation: () => Promise<{ succeeded: string[]; failed: { id: string; code: string; message: string }[] }>,
    options?: { errorSurface?: 'toast' | 'throw' },
  ) {
    const errorSurface = options?.errorSurface ?? 'toast';
    setOperationPending(true);
    try {
      const result = await operation();
      if (result.failed.length) {
        selection.replace(result.failed.map((failure) => failure.id));
        const detail = result.failed
          .slice(0, 3)
          .map((failure) => failure.message || failure.code)
          .join('; ');
        // Defer so move/copy/delete dialogs can release inert before toast chrome mounts.
        scheduleDeferredFeedback(() => pushToast('error', t('feedback.batchPartialDetail', {
          completed: result.succeeded.length,
          failed: result.failed.length,
          detail,
        })));
      } else {
        selection.clear();
        scheduleDeferredFeedback(() => pushToast('success', t('feedback.batchComplete', { completed: result.succeeded.length })));
      }
      directory.refresh();
    } catch (error) {
      if (errorSurface === 'throw') throw error;
      scheduleDeferredFeedback(() => pushToast('error', localizedApiError(error, t, 'feedback.operationFailed')));
    } finally {
      setOperationPending(false);
    }
  }

  function openEntryAction(action: EntryActionId, entry: Entry) {
    if (action === 'share') setShareError(null);
    if (action === 'rename' || action === 'properties' || action === 'move' || action === 'delete' || action === 'share') {
      setDialog({ type: action, entries: [entry] });
    }
    if (action === 'copyTo') setDialog({ type: 'copy', entries: [entry] });
    if (action === 'publish' || action === 'hide') void runBatch(() => setVisibility([entry.id], action === 'publish'));
  }

  const currentEntryActions = menu ? entryActions(menu.entry, {
    onOpen: handlers.onOpen,
    onPreview: handlers.onPreview,
    onAction: openEntryAction,
    onCopySuccess: () => pushToast('success', t('feedback.linkCopied')),
    onCopyFailure: () => pushToast('error', t('feedback.copyFailed')),
    canShare: admin,
  }) : [];

  return (
    <>
      <main className="explorerPage" id="file-explorer">
        <div className="explorerBrowser">
          <div className="explorerToolbarSlot">
            {admin && selectedEntries.length > 0 ? <SelectionToolbar
              count={selectedEntries.length}
              pending={operationPending}
              canMove={selectionCapabilities.canMove}
              canCopy={selectionCapabilities.canCopy}
              canPublish={selectionCapabilities.canPublish}
              canHide={selectionCapabilities.canHide}
              canDelete={selectionCapabilities.canDelete}
              onMove={() => setDialog({ type: 'move', entries: selectedEntries.filter((entry) => entry.capabilities.move) })}
              onCopy={() => setDialog({ type: 'copy', entries: selectedEntries.filter((entry) => entry.capabilities.copy) })}
              onPublish={() => void runBatch(() => setVisibility(selectedEntries.filter((entry) => entry.capabilities.changeVisibility).map((entry) => entry.id), true))}
              onHide={() => void runBatch(() => setVisibility(selectedEntries.filter((entry) => entry.capabilities.changeVisibility).map((entry) => entry.id), false))}
              onDelete={() => setDialog({ type: 'delete', entries: selectedEntries.filter((entry) => entry.capabilities.delete) })}
              onClear={selection.clear}
            /> : <ExplorerToolbar
              breadcrumbs={directory.data?.breadcrumbs ?? []}
              query={query}
              sort={sort}
              view={view}
              refreshing={directory.loading}
              sessionStatus={session.status}
              selectionCount={selectedEntries.length}
              canUpload={canUpload}
              canCreateFolder={canCreateFolder}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              onQuery={setQuery}
              onOpenPath={onOpenPath}
              onRefresh={directory.refresh}
              onSort={setSort}
              onView={(nextView) => updatePreferences({ defaultView: nextView })}
              onUpload={enqueueFiles}
              onUploadFolder={(items) => void uploadRelativeFiles(items)}
              onCreateFolder={() => setDialog({ type: 'create', entries: [] })}
            />}
          </div>
          <section className={`explorerContent${dragOver ? ' isDragOver' : ''}`} id="file-list" tabIndex={-1} aria-label={previewId ? t('explorer.filesWithPreview', { id: previewId }) : t('nav.files')} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            {directory.error && directory.data ? <div className="retryBanner" role="alert"><CircleAlert aria-hidden="true" size={18} /><span>{directoryErrorHint(directory.error, t)}</span><button type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={15} />{t('action.retry')}</button></div> : null}
            {directory.loading && !directory.data ? <LoadingCollection view={view} label={t('state.loadingFiles')} /> : null}
            {directory.error && !directory.data ? <div className="errorState" role="alert"><CircleAlert aria-hidden="true" size={32} /><strong>{directoryErrorTitle(directory.error, t)}</strong><span>{directoryErrorHint(directory.error, t)}</span><button className="button" type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={16} />{t('action.retry')}</button></div> : null}
            {directory.data && !directory.loading && !directory.error && entries.length === 0 ? <EmptyState query={normalizedQuery || serverQuery} admin={admin} /> : null}
            {directory.data && entries.length > 0 ? <ExplorerCollection
              view={view}
              entries={entries}
              selectedIds={selection.selectedIds}
              admin={admin}
              handlers={handlers}
              onSelectAll={selection.selectAll}
              onReplaceSelection={selection.replace}
              onClearSelection={selection.clear}
              sort={sort}
              onSort={setSort}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleSelectAll={(checked) => checked ? selection.selectAll(mutableVisibleIds) : selection.clear()}
            /> : null}
            {directory.data && directory.hasMore && !normalizedQuery ? (
              <div className="explorerFooter">
                <button
                  className="button"
                  type="button"
                  disabled={directory.loadingMore}
                  onClick={directory.loadMore}
                >
                  {directory.loadingMore ? t('status.loadingMore') : t('action.loadMore')}
                </button>
              </div>
            ) : null}
            {directory.loading && directory.data ? <div className="refreshing" role="status" aria-label={t('state.refreshing')}><LoaderCircle aria-hidden="true" size={16} />{t('state.refreshing')}</div> : null}
          </section>
        </div>
      </main>
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
      {menu && !mobileActions ? <EntryActionMenu entry={menu.entry} anchor={menu.anchor} actions={currentEntryActions} onClose={() => setMenu(null)} /> : null}
      {menu && mobileActions ? <MobileActionSheet open title={t('entry.actions', { name: menu.entry.name })} anchor={menu.anchor} actions={currentEntryActions} translate={t} cancelLabel={t('action.cancel')} onClose={() => setMenu(null)} /> : null}
      <Suspense fallback={null}>
        {dialog?.type === 'rename' ? <RenameDialog open title={t('dialog.renameTitle', { name: dialog.entries[0].name })} initialName={dialog.entries[0].name} onClose={() => setDialog(null)} onSubmit={async (name) => {
          const targetId = dialog.entries[0].id;
          directory.applyLocalUpdate((current) => ({
            ...current,
            items: current.items.map((item) => item.id === targetId ? { ...item, name } : item),
          }));
          try {
            await patchEntry(targetId, { name });
          } finally {
            directory.refresh();
          }
          // Defer toast until after RenameDialog closes and clears modal inert.
          scheduleDeferredFeedback(() => { pushToast('success', t('feedback.renamed')); });
        }} /> : null}
        {dialog?.type === 'create' && directory.data && canCreateFolder ? <RenameDialog open title={t('toolbar.createFolder')} submitLabel={t('common.save')} onClose={() => setDialog(null)} onSubmit={async (name) => {
          await createFolder(directory.data!.current.id, name);
          directory.refresh();
          scheduleDeferredFeedback(() => { pushToast('success', t('feedback.folderCreated')); });
        }} /> : null}
        {dialog?.type === 'move' ? <FolderPickerDialog mode="move" entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={(destinationId) => runBatch(() => moveEntries(dialog.entries.map((entry) => entry.id), destinationId), { errorSurface: 'throw' })} /> : null}
        {dialog?.type === 'copy' ? <FolderPickerDialog mode="copy" entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={(destinationId) => runBatch(() => copyEntries(dialog.entries.map((entry) => entry.id), destinationId), { errorSurface: 'throw' })} /> : null}
        {dialog?.type === 'delete' ? <DeleteDialog entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={async () => {
          const targetIds = dialog.entries.map((entry) => entry.id);
          await runBatch(async () => {
            const result = await deleteEntries(targetIds);
            if (result.succeeded.length > 0) {
              const removed = new Set(result.succeeded);
              directory.applyLocalUpdate((current) => ({
                ...current,
                items: current.items.filter((item) => !removed.has(item.id)),
              }));
            }
            return result;
          }, { errorSurface: 'throw' });
        }} /> : null}
        {dialog?.type === 'properties' ? <PropertiesDialog entry={dialog.entries[0]} onClose={() => setDialog(null)} onSubmit={async (entryPatch) => {
          await patchEntry(dialog.entries[0].id, entryPatch);
          directory.refresh();
          scheduleDeferredFeedback(() => { pushToast('success', t('feedback.propertiesSaved')); });
        }} /> : null}
        {dialog?.type === 'share' ? <ShareDialog entry={dialog.entries[0]} busy={operationPending} error={shareError} onClose={() => { setDialog(null); setShareError(null); }} onCreate={async (input) => { setOperationPending(true); setShareError(null); try { return await createShare(input); } catch (error) { setShareError(localizedApiError(error, t, 'share.unableSave')); throw error; } finally { setOperationPending(false); } }} /> : null}
        {previewId ? <PreviewOverlay entry={previewEntry} entries={entries} onSelectEntry={(next) => onOpenPreview(next.id)} loading={previewLoading} error={previewError} onClose={onClosePreview} /> : null}
      </Suspense>
    </>
  );
}
