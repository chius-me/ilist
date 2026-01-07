import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { createFolder, deleteEntries, entryPath, getEntry, moveEntries, patchEntry, setVisibility } from '../api/entries';
import { ApiError } from '../api/client';
import { ToastRegion, type ToastMessage, type ToastTone } from '../components/ToastRegion';
import { Breadcrumbs } from '../features/explorer/Breadcrumbs';
import { EmptyState } from '../features/explorer/EmptyState';
import { entryActions, EntryActionMenu, type EntryActionId } from '../features/explorer/EntryActionMenu';
import { ExplorerCollection } from '../features/explorer/ExplorerCollection';
import { ExplorerToolbar, type ExplorerSort, type ExplorerView } from '../features/explorer/ExplorerToolbar';
import type { EntryHandlers } from '../features/explorer/EntryRow';
import { MobileActionSheet } from '../features/explorer/MobileActionSheet';
import { SelectionToolbar } from '../features/explorer/SelectionToolbar';
import { DeleteDialog } from '../features/operations/DeleteDialog';
import { FolderPickerDialog } from '../features/operations/FolderPickerDialog';
import { PropertiesDialog } from '../features/operations/PropertiesDialog';
import { RenameDialog } from '../features/operations/RenameDialog';
import { PreviewOverlay } from '../features/preview/PreviewOverlay';
import { UploadPanel } from '../features/uploads/UploadPanel';
import { useUploadQueue } from '../features/uploads/useUploadQueue';
import { useDirectory } from '../hooks/useDirectory';
import { useSelection } from '../hooks/useSelection';
import type { useSession } from '../hooks/useSession';
import { useI18n } from '../i18n/I18nProvider';
import { usePreferences } from '../preferences/PreferencesProvider';
import { isEntryMutable, type Entry } from '../types/entries';

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

function compareEntries(left: Entry, right: Entry, sort: ExplorerSort): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const direction = sort.order === 'asc' ? 1 : -1;
  let result = 0;
  if (sort.field === 'size') result = left.size - right.size;
  if (sort.field === 'updated') result = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  return (result || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })) * direction;
}

function LoadingCollection({ view, label }: { view: ExplorerView; label: string }) {
  if (view === 'grid') {
    return <div className="loadingGrid" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((card) => <div className="loadingCard" key={card}><span /><span /><span /></div>)}
    </div>;
  }
  return (
    <div className="loadingRows" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3, 4].map((row) => <div className="loadingRow" key={row}><span /><span /><span /></div>)}
    </div>
  );
}

function directoryErrorTitle(error: Error, t: ReturnType<typeof useI18n>['t']): string {
  if (error instanceof ApiError && error.code === 'MOUNT_DISABLED') return t('state.disconnected');
  if (error instanceof ApiError && (error.status === 404 || error.code === 'ENTRY_NOT_FOUND' || error.code === 'MOUNT_NOT_FOUND')) return t('state.unavailable');
  return t('state.loadFailed');
}

function directoryErrorHint(error: Error, t: ReturnType<typeof useI18n>['t']): string {
  if (error instanceof ApiError && error.code === 'MOUNT_DISABLED') return t('state.disconnectedHint');
  if (error instanceof ApiError && (error.status === 404 || error.code === 'ENTRY_NOT_FOUND' || error.code === 'MOUNT_NOT_FOUND')) return t('state.unavailableHint');
  return error.message;
}

export interface ExplorerPageProps {
  path: string;
  previewId: string | null;
  session: ReturnType<typeof useSession>;
  onOpenPath(path: string): void;
  onOpenPreview(id: string): void;
  onClosePreview(): void;
  onRequestLogin(): void;
}

export function ExplorerPage({
  path,
  previewId,
  session,
  onOpenPath,
  onOpenPreview,
  onClosePreview,
}: ExplorerPageProps) {
  const directory = useDirectory(path, session.status);
  const selection = useSelection();
  const { t } = useI18n();
  const { preferences, updatePreferences } = usePreferences();
  const view: ExplorerView = preferences.defaultView;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ExplorerSort>({ field: 'name', order: 'asc' });
  const [previewEntry, setPreviewEntry] = useState<Entry | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<Error | null>(null);
  const [menu, setMenu] = useState<{ entry: Entry; anchor: HTMLElement | null } | null>(null);
  const [dialog, setDialog] = useState<{ type: 'rename' | 'create' | 'move' | 'delete' | 'properties'; entries: Entry[] } | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSequence = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const mobileActions = useMobileActions();
  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const pushToast = useCallback((tone: ToastTone, message: string) => {
    toastSequence.current += 1;
    setToasts((current) => [...current, { id: `toast-${toastSequence.current}`, tone, message }].slice(-4));
  }, []);

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
    setMenu(null);
  }, [path, selection.clear]);

  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (directory.data?.items ?? [])
      .filter((entry) => !needle || `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => compareEntries(left, right, sort));
  }, [directory.data, query, sort]);

  const admin = session.status === 'admin';
  const mutableVisibleIds = useMemo(() => admin ? entries.filter(isEntryMutable).map((entry) => entry.id) : [], [admin, entries]);
  const canUpload = admin && directory.data?.current.capabilities.upload === true;
  const canCreateFolder = admin && directory.data?.current.capabilities.createFolder === true;
  const uploads = useUploadQueue({
    canUpload,
    existingNames: directory.data?.items.map((entry) => entry.name) ?? [],
    onCompleted: (parentId) => {
      if (directory.data?.current.id === parentId) directory.refresh();
    },
  });
  const handlers: EntryHandlers = {
    onOpen: (entry) => onOpenPath(entryPath(path, entry)),
    onPreview: (entry) => onOpenPreview(entry.id),
    onToggle: (entry, options) => {
      if (!isEntryMutable(entry)) return;
      if (options?.range) selection.range(mutableVisibleIds, entry.id);
      else selection.toggle(entry.id);
    },
    onMenu: (entry, anchor) => setMenu({ entry, anchor: anchor ?? null }),
  };
  const selectedEntries = entries.filter((entry) => selection.selectedIds.has(entry.id) && isEntryMutable(entry));

  function enqueueFiles(files: File[]) {
    if (directory.data && canUpload) uploads.enqueue(directory.data.current.id, files);
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
    enqueueFiles(Array.from(event.dataTransfer.files));
  }

  async function runBatch(operation: () => Promise<{ succeeded: string[]; failed: { id: string }[] }>) {
    setOperationPending(true);
    try {
      const result = await operation();
      if (result.failed.length) {
        selection.replace(result.failed.map((failure) => failure.id));
        pushToast('error', t('feedback.batchPartial', { completed: result.succeeded.length, failed: result.failed.length }));
      } else {
        selection.clear();
        pushToast('success', t('feedback.batchComplete', { completed: result.succeeded.length }));
      }
      directory.refresh();
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('feedback.operationFailed'));
      throw error;
    } finally {
      setOperationPending(false);
    }
  }

  function openEntryAction(action: EntryActionId, entry: Entry) {
    if (action === 'rename' || action === 'properties' || action === 'move' || action === 'delete') setDialog({ type: action, entries: [entry] });
    if (action === 'publish' || action === 'hide') void runBatch(() => setVisibility([entry.id], action === 'publish'));
  }

  const currentEntryActions = menu ? entryActions(menu.entry, { onOpen: handlers.onOpen, onPreview: handlers.onPreview, onAction: openEntryAction }) : [];

  return (
    <>
      <main className="explorerPage" id="file-explorer">
        <div className="explorerBrowser">
          {directory.data ? <Breadcrumbs items={directory.data.breadcrumbs} onOpen={onOpenPath} /> : <div className="breadcrumbPlaceholder" aria-hidden="true" />}
          <div className="explorerToolbarSlot">
            {admin && selectedEntries.length > 0 ? <SelectionToolbar count={selectedEntries.length} pending={operationPending} onMove={() => setDialog({ type: 'move', entries: selectedEntries })} onPublish={() => void runBatch(() => setVisibility(selectedEntries.map((entry) => entry.id), true))} onHide={() => void runBatch(() => setVisibility(selectedEntries.map((entry) => entry.id), false))} onDelete={() => setDialog({ type: 'delete', entries: selectedEntries })} onClear={selection.clear} /> : <ExplorerToolbar
              query={query}
              sort={sort}
              view={view}
              sessionStatus={session.status}
              selectionCount={selectedEntries.length}
              canUpload={canUpload}
              canCreateFolder={canCreateFolder}
              onQuery={setQuery}
              onSort={setSort}
              onView={(nextView) => updatePreferences({ defaultView: nextView })}
              onUpload={enqueueFiles}
              onCreateFolder={() => setDialog({ type: 'create', entries: [] })}
            />}
          </div>
          <section className={`explorerContent${dragOver ? ' isDragOver' : ''}`} id="file-list" tabIndex={-1} aria-label={previewId ? `Files with preview ${previewId} selected` : 'Files'} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            <div className="directoryCommands"><button className="iconButton" type="button" onClick={directory.refresh} disabled={directory.loading} aria-label={t('action.refresh')} title={t('action.refresh')}><RefreshCw aria-hidden="true" size={16} /></button></div>
            {directory.error && directory.data ? <div className="retryBanner" role="alert"><AlertCircle aria-hidden="true" size={18} /><span>{directory.error.message}</span><button type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={15} />{t('action.retry')}</button></div> : null}
            {directory.loading && !directory.data ? <LoadingCollection view={view} label={t('state.loadingFiles')} /> : null}
            {directory.error && !directory.data ? <div className="errorState" role="alert"><AlertCircle aria-hidden="true" size={32} /><strong>{directoryErrorTitle(directory.error, t)}</strong><span>{directoryErrorHint(directory.error, t)}</span><button className="button" type="button" onClick={directory.refresh}><RefreshCw aria-hidden="true" size={16} />{t('action.retry')}</button></div> : null}
            {directory.data && !directory.loading && !directory.error && entries.length === 0 ? <EmptyState query={query} admin={admin} /> : null}
            {directory.data && entries.length > 0 ? <ExplorerCollection
              view={view}
              entries={entries}
              selectedIds={selection.selectedIds}
              admin={admin}
              handlers={handlers}
              onSelectAll={selection.selectAll}
              onReplaceSelection={selection.replace}
              onClearSelection={selection.clear}
            /> : null}
            {directory.loading && directory.data ? <div className="refreshing" role="status" aria-label={t('state.refreshing')}><LoaderCircle aria-hidden="true" size={16} />{t('state.refreshing')}</div> : null}
          </section>
        </div>
      </main>
      <UploadPanel tasks={uploads.tasks} onCancel={uploads.cancel} onRetry={uploads.retry} onRemove={uploads.remove} onClearCompleted={uploads.clearCompleted} />
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
      {menu && !mobileActions ? <EntryActionMenu entry={menu.entry} anchor={menu.anchor} actions={currentEntryActions} onClose={() => setMenu(null)} /> : null}
      {menu && mobileActions ? <MobileActionSheet open title={t('entry.actions', { name: menu.entry.name })} anchor={menu.anchor} actions={currentEntryActions} translate={t} cancelLabel={t('action.cancel')} onClose={() => setMenu(null)} /> : null}
      {dialog?.type === 'rename' ? <RenameDialog open title={t('dialog.renameTitle', { name: dialog.entries[0].name })} initialName={dialog.entries[0].name} onClose={() => setDialog(null)} onSubmit={async (name) => { await patchEntry(dialog.entries[0].id, { name }); directory.refresh(); }} /> : null}
      {dialog?.type === 'create' && directory.data && canCreateFolder ? <RenameDialog open title={t('toolbar.createFolder')} submitLabel={t('common.save')} onClose={() => setDialog(null)} onSubmit={async (name) => { await createFolder(directory.data!.current.id, name); directory.refresh(); }} /> : null}
      {dialog?.type === 'move' ? <FolderPickerDialog entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={(destinationId) => runBatch(() => moveEntries(dialog.entries.map((entry) => entry.id), destinationId))} /> : null}
      {dialog?.type === 'delete' ? <DeleteDialog entries={dialog.entries} onClose={() => setDialog(null)} onSubmit={() => runBatch(() => deleteEntries(dialog.entries.map((entry) => entry.id)))} /> : null}
      {dialog?.type === 'properties' ? <PropertiesDialog entry={dialog.entries[0]} onClose={() => setDialog(null)} onSubmit={async (entryPatch) => { await patchEntry(dialog.entries[0].id, entryPatch); directory.refresh(); }} /> : null}
      {previewId ? <PreviewOverlay entry={previewEntry} loading={previewLoading} error={previewError} onClose={onClosePreview} /> : null}
    </>
  );
}
