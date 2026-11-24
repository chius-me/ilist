import { ArrowDownAZ, CircleAlert, Grid2X2, List, RefreshCw, Search, Share2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { getPublicShare, listPublicShare, publicShareFileUrl, unlockPublicShare } from '../api/public-shares';
import { ExplorerCollection } from '../features/explorer/ExplorerCollection';
import { entryActions, EntryActionMenu } from '../features/explorer/EntryActionMenu';
import type { EntryHandlers } from '../features/explorer/EntryRow';
import type { ExplorerSort, ExplorerSortField } from '../features/explorer/ExplorerToolbar';
import { MobileActionSheet, useMobileActions } from '../features/explorer/MobileActionSheet';
import { SharePasswordForm } from '../features/shares/SharePasswordForm';
import { useI18n } from '../i18n/I18nProvider';
import { localizedApiError } from '../i18n/apiErrors';
import type { MessageKey } from '../i18n/messages';
import { normalizeDirectoryQuery } from '../lib/directory-query';
import { sortEntries } from '../lib/explorer-sort';
import { usePreferences } from '../preferences/PreferencesProvider';
import type { DirectoryResponse, Entry } from '../types/entries';
import type { PublicShareMeta } from '../types/shares';
import { AppShell } from './AppShell';

const PreviewOverlay = lazy(() => import('../features/preview/PreviewOverlay').then((module) => ({ default: module.PreviewOverlay })));

const STATE_COPY: Record<string, readonly [MessageKey, MessageKey]> = {
  SHARE_DISABLED: ['publicShare.disabledTitle', 'publicShare.disabledHint'],
  SHARE_EXPIRED: ['publicShare.expiredTitle', 'publicShare.expiredHint'],
  SHARE_PROVIDER_UNAVAILABLE: ['publicShare.unavailableTitle', 'publicShare.unavailableHint'],
};

interface ShareTrailItem {
  id: string | null;
  name: string;
}

type FailedNav =
  | { type: 'open'; entry: Entry }
  | { type: 'trail'; index: number };

function buildShareUrl(folderId: string | null, previewId: string | null): string {
  const url = new URL(window.location.href);
  if (folderId) url.searchParams.set('folder', folderId);
  else url.searchParams.delete('folder');
  if (previewId) url.searchParams.set('preview', previewId);
  else url.searchParams.delete('preview');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function SharePage({ token }: { token: string }) {
  const { formatDate, t } = useI18n();
  const { preferences, updatePreferences } = usePreferences();
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Entry | null>(null);
  const [trail, setTrail] = useState<ShareTrailItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ExplorerSort>({ field: 'name', order: 'asc' });
  const [menu, setMenu] = useState<{ entry: Entry; anchor: HTMLElement | null } | null>(null);
  const failedNav = useRef<FailedNav | null>(null);
  const mobileActions = useMobileActions();

  const currentFolderId = trail.length > 0 ? trail[trail.length - 1]!.id : null;

  const load = useCallback(async () => {
    setError(null);
    setFolderError(null);
    failedNav.current = null;
    try {
      const value = await getPublicShare(token);
      setMeta(value);
      setPasswordRequired(false);
      const params = new URLSearchParams(window.location.search);
      const initialFolderId = params.get('folder');
      const initialPreviewId = params.get('preview');
      if (value.targetKind === 'folder') {
        const listed = await listPublicShare(token, initialFolderId ?? undefined);
        setDirectory(listed);
        setTrail(
          initialFolderId
            ? [{ id: null, name: value.name }, { id: initialFolderId, name: listed.current.name || initialFolderId }]
            : [{ id: null, name: value.name }],
        );
        if (initialPreviewId) {
          setPreview(listed.items.find((item) => item.id === initialPreviewId) ?? null);
        }
      } else {
        setPreview(value.entry);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'SHARE_PASSWORD_REQUIRED') {
        setPasswordRequired(true);
        return;
      }
      setError(cause instanceof ApiError ? cause : new ApiError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Unavailable'));
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    document.title = meta?.name ? `${meta.name} · iList` : 'iList';
  }, [meta?.name]);

  useEffect(() => {
    if (!meta) return;
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const nextFolderId = params.get('folder');
      const nextPreviewId = params.get('preview');
      if (meta.targetKind === 'folder') {
        if (nextFolderId !== currentFolderId) {
          void listPublicShare(token, nextFolderId ?? undefined).then((listed) => {
            setDirectory(listed);
            setQuery('');
            setTrail((existing) => {
              if (!nextFolderId) return [{ id: null, name: meta.name }];
              const existingIndex = existing.findIndex((item) => item.id === nextFolderId);
              if (existingIndex >= 0) return existing.slice(0, existingIndex + 1);
              return [{ id: null, name: meta.name }, { id: nextFolderId, name: listed.current.name || nextFolderId }];
            });
            setPreview(nextPreviewId ? listed.items.find((item) => item.id === nextPreviewId) ?? null : null);
          }).catch(() => undefined);
          return;
        }
        setPreview(nextPreviewId ? (directory?.items.find((item) => item.id === nextPreviewId) ?? null) : null);
      } else {
        setPreview(nextPreviewId === meta.entry.id ? meta.entry : null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [currentFolderId, directory?.items, meta, token]);

  async function unlock(password: string) {
    setBusy(true);
    setPasswordError(null);
    try {
      await unlockPublicShare(token, password);
      await load();
    } catch (cause) {
      setPasswordError(localizedApiError(cause, t, 'publicShare.passwordInvalid'));
    } finally {
      setBusy(false);
    }
  }

  async function openFolder(entry: Entry) {
    try {
      setFolderError(null);
      const next = await listPublicShare(token, entry.id);
      setDirectory(next);
      setQuery('');
      setPreview(null);
      setTrail((current) => [...current, { id: entry.id, name: entry.name }]);
      failedNav.current = null;
      window.history.pushState(null, '', buildShareUrl(entry.id, null));
    } catch (cause) {
      failedNav.current = { type: 'open', entry };
      setFolderError(localizedApiError(cause, t, 'publicShare.unavailableHint'));
    }
  }

  async function openTrail(index: number) {
    const target = trail[index];
    if (!target || index === trail.length - 1) return;
    try {
      setFolderError(null);
      const next = await listPublicShare(token, target.id ?? undefined);
      setDirectory(next);
      setQuery('');
      setPreview(null);
      setTrail((current) => current.slice(0, index + 1));
      failedNav.current = null;
      window.history.pushState(null, '', buildShareUrl(target.id, null));
    } catch (cause) {
      failedNav.current = { type: 'trail', index };
      setFolderError(localizedApiError(cause, t, 'publicShare.unavailableHint'));
    }
  }

  function openPreviewEntry(entry: Entry) {
    setPreview(entry);
    window.history.pushState(null, '', buildShareUrl(currentFolderId, entry.id));
  }

  function closePreviewEntry() {
    setPreview(null);
    window.history.replaceState(null, '', buildShareUrl(currentFolderId, null));
  }

  async function retryFolder() {
    const failed = failedNav.current;
    if (!failed) {
      await load();
      return;
    }
    if (failed.type === 'open') await openFolder(failed.entry);
    else await openTrail(failed.index);
  }

  const visibleEntries = useMemo(() => {
    const items = directory?.items ?? [];
    const normalized = normalizeDirectoryQuery(query).toLowerCase();
    const filtered = normalized
      ? items.filter((item) => item.name.toLowerCase().includes(normalized))
      : items;
    return sortEntries(filtered, sort);
  }, [directory, query, sort]);

  const handlers: EntryHandlers = {
    onOpen: (entry) => void openFolder(entry),
    onPreview: openPreviewEntry,
    onToggle: () => undefined,
    onMenu: (entry, anchor) => setMenu({ entry, anchor: anchor ?? null }),
  };
  const urlFor = (entry: Entry, download: boolean, exportFormat?: string) => publicShareFileUrl(token, entry, download, exportFormat);
  const currentEntryActions = menu ? entryActions(menu.entry, {
    onOpen: handlers.onOpen,
    onPreview: handlers.onPreview,
    onAction: () => undefined,
    fileUrlFor: urlFor,
  }) : [];

  let content: ReactNode;
  if (passwordRequired) {
    content = <SharePasswordForm busy={busy} error={passwordError} onSubmit={(password) => void unlock(password)} />;
  } else if (error) {
    const [title, hint] = STATE_COPY[error.code] ?? ['publicShare.missingTitle', 'publicShare.missingHint'];
    content = <main className="shareStatePage" id="shared-content"><div className="shareUnavailable"><CircleAlert aria-hidden="true" size={32} /><h1>{t(title)}</h1><p>{t(hint)}</p></div></main>;
  } else if (!meta || (meta.targetKind === 'folder' && !directory)) {
    content = <main className="shareStatePage" id="shared-content"><div role="status">{t('publicShare.loading')}</div></main>;
  } else {
    content = <main className="publicSharePage" id="shared-content">
      <header className="sharePageHeader"><div><Share2 aria-hidden="true" size={20} /><span><h1>{meta.name}</h1><small>{meta.expiresAt ? t('publicShare.expires', { date: formatDate(meta.expiresAt) }) : t('publicShare.sharedByIlist')}</small></span></div>{meta.targetKind === 'folder' ? <span className="shareViewControl"><button type="button" className={preferences.defaultView === 'list' ? 'isActive' : ''} aria-label={t('toolbar.list')} onClick={() => updatePreferences({ defaultView: 'list' })}><List aria-hidden="true" size={16} /></button><button type="button" className={preferences.defaultView === 'grid' ? 'isActive' : ''} aria-label={t('toolbar.grid')} onClick={() => updatePreferences({ defaultView: 'grid' })}><Grid2X2 aria-hidden="true" size={16} /></button></span> : null}</header>
      {meta.targetKind === 'folder' ? (
        <div className="shareToolbarRow">
          <nav className="shareBreadcrumbs" aria-label={t('publicShare.path')}>
            {trail.map((item, index) => (
              <span key={item.id ?? 'share-root'}>
                <button type="button" disabled={index === trail.length - 1} onClick={() => void openTrail(index)}>{item.name}</button>
                {index < trail.length - 1 ? <i aria-hidden="true">/</i> : null}
              </span>
            ))}
          </nav>
          <div className="shareFilterControls">
            <label className="searchControl shareSearchControl">
              <Search aria-hidden="true" size={15} />
              <span className="srOnly">{t('share.searchPlaceholder')}</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('share.searchPlaceholder')}
                aria-label={t('share.searchPlaceholder')}
              />
            </label>
            <label className="sortControl">
              <span className="srOnly">{t('toolbar.sort')}</span>
              <select
                value={sort.field}
                onChange={(event) => setSort({ ...sort, field: event.target.value as ExplorerSortField })}
                aria-label={t('toolbar.sort')}
              >
                <option value="name">{t('toolbar.name')}</option>
                <option value="updated">{t('toolbar.modified')}</option>
                <option value="size">{t('toolbar.size')}</option>
              </select>
            </label>
            <button
              className="iconButton"
              type="button"
              title={sort.order === 'asc' ? t('toolbar.ascending') : t('toolbar.descending')}
              aria-label={sort.order === 'asc' ? t('toolbar.sortAscending') : t('toolbar.sortDescending')}
              onClick={() => setSort({ ...sort, order: sort.order === 'asc' ? 'desc' : 'asc' })}
            >
              <ArrowDownAZ aria-hidden="true" size={16} className={sort.order === 'desc' ? 'sortDescending' : undefined} />
            </button>
          </div>
        </div>
      ) : null}
      {folderError ? <div className="retryBanner" role="alert"><CircleAlert aria-hidden="true" size={18} /><span>{folderError}</span><button type="button" onClick={() => void retryFolder()}><RefreshCw aria-hidden="true" size={15} />{t('action.retry')}</button></div> : null}
      {directory ? <section className="sharedCollection"><ExplorerCollection view={preferences.defaultView} entries={visibleEntries} selectedIds={new Set()} admin={false} handlers={handlers} onSelectAll={() => undefined} onReplaceSelection={() => undefined} onClearSelection={() => undefined} fileUrlFor={urlFor} sort={sort} onSort={setSort} /></section> : <button className="sharedFileButton button" type="button" onClick={() => openPreviewEntry(meta.entry)}>{t('action.preview')}</button>}
    </main>;
  }

  return <AppShell admin={false} contentId="shared-content" publicView onHome={() => { window.location.assign('/'); }} onStorage={() => undefined} onSignIn={() => undefined} onSignOut={() => undefined}>{content}
    {menu && !mobileActions ? <EntryActionMenu entry={menu.entry} anchor={menu.anchor} actions={currentEntryActions} onClose={() => setMenu(null)} /> : null}
    {menu && mobileActions ? <MobileActionSheet open title={t('entry.actions', { name: menu.entry.name })} anchor={menu.anchor} actions={currentEntryActions} translate={t} cancelLabel={t('action.cancel')} onClose={() => setMenu(null)} /> : null}
    {preview ? <Suspense fallback={null}><PreviewOverlay entry={preview} entries={visibleEntries} onSelectEntry={meta?.targetKind === 'folder' ? openPreviewEntry : undefined} onClose={closePreviewEntry} urlFor={urlFor} allowDownload={meta?.allowDownload ?? false} /></Suspense> : null}
  </AppShell>;
}
