import { AlertCircle, Grid2X2, List, Share2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { getPublicShare, listPublicShare, publicShareFileUrl, unlockPublicShare } from '../api/public-shares';
import { ExplorerCollection } from '../features/explorer/ExplorerCollection';
import { entryActions, EntryActionMenu } from '../features/explorer/EntryActionMenu';
import type { EntryHandlers } from '../features/explorer/EntryRow';
import { MobileActionSheet, useMobileActions } from '../features/explorer/MobileActionSheet';
import { PreviewOverlay } from '../features/preview/PreviewOverlay';
import { SharePasswordForm } from '../features/shares/SharePasswordForm';
import { useI18n } from '../i18n/I18nProvider';
import { localizedApiError } from '../i18n/apiErrors';
import type { MessageKey } from '../i18n/messages';
import { usePreferences } from '../preferences/PreferencesProvider';
import type { DirectoryResponse, Entry } from '../types/entries';
import type { PublicShareMeta } from '../types/shares';
import { AppShell } from './AppShell';

const STATE_COPY: Record<string, readonly [MessageKey, MessageKey]> = {
  SHARE_DISABLED: ['publicShare.disabledTitle', 'publicShare.disabledHint'],
  SHARE_EXPIRED: ['publicShare.expiredTitle', 'publicShare.expiredHint'],
  SHARE_PROVIDER_UNAVAILABLE: ['publicShare.unavailableTitle', 'publicShare.unavailableHint'],
};

interface ShareTrailItem {
  id: string | null;
  name: string;
}

export function SharePage({ token }: { token: string }) {
  const { t } = useI18n();
  const { preferences, updatePreferences } = usePreferences();
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Entry | null>(null);
  const [trail, setTrail] = useState<ShareTrailItem[]>([]);
  const [menu, setMenu] = useState<{ entry: Entry; anchor: HTMLElement | null } | null>(null);
  const mobileActions = useMobileActions();

  const load = useCallback(async () => {
    setError(null);
    try {
      const value = await getPublicShare(token);
      setMeta(value);
      setPasswordRequired(false);
      if (value.targetKind === 'folder') {
        setDirectory(await listPublicShare(token));
        setTrail([{ id: null, name: value.name }]);
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
      setDirectory(await listPublicShare(token, entry.id));
      setTrail((current) => [...current, { id: entry.id, name: entry.name }]);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Unavailable'));
    }
  }

  async function openTrail(index: number) {
    const target = trail[index];
    if (!target || index === trail.length - 1) return;
    try {
      setDirectory(await listPublicShare(token, target.id ?? undefined));
      setTrail((current) => current.slice(0, index + 1));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(503, 'SHARE_PROVIDER_UNAVAILABLE', 'Unavailable'));
    }
  }

  const handlers: EntryHandlers = {
    onOpen: (entry) => void openFolder(entry),
    onPreview: setPreview,
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

  let content;
  if (passwordRequired) {
    content = <SharePasswordForm busy={busy} error={passwordError} onSubmit={(password) => void unlock(password)} />;
  } else if (error) {
    const [title, hint] = STATE_COPY[error.code] ?? ['publicShare.missingTitle', 'publicShare.missingHint'];
    content = <main className="shareStatePage" id="shared-content"><div className="shareUnavailable"><AlertCircle aria-hidden="true" size={32} /><h1>{t(title)}</h1><p>{t(hint)}</p></div></main>;
  } else if (!meta || (meta.targetKind === 'folder' && !directory)) {
    content = <main className="shareStatePage" id="shared-content"><div role="status">{t('publicShare.loading')}</div></main>;
  } else {
    content = <main className="publicSharePage" id="shared-content">
      <header className="sharePageHeader"><div><Share2 aria-hidden="true" size={20} /><span><h1>{meta.name}</h1><small>{meta.expiresAt ? t('publicShare.expires', { date: meta.expiresAt }) : t('publicShare.sharedByIlist')}</small></span></div>{meta.targetKind === 'folder' ? <span className="shareViewControl"><button className={preferences.defaultView === 'list' ? 'isActive' : ''} aria-label={t('toolbar.list')} onClick={() => updatePreferences({ defaultView: 'list' })}><List aria-hidden="true" size={16} /></button><button className={preferences.defaultView === 'grid' ? 'isActive' : ''} aria-label={t('toolbar.grid')} onClick={() => updatePreferences({ defaultView: 'grid' })}><Grid2X2 aria-hidden="true" size={16} /></button></span> : null}</header>
      {meta.targetKind === 'folder' ? <nav className="shareBreadcrumbs" aria-label={t('publicShare.path')}>{trail.map((item, index) => <span key={`${item.id ?? 'root'}:${index}`}><button type="button" disabled={index === trail.length - 1} onClick={() => void openTrail(index)}>{item.name}</button>{index < trail.length - 1 ? <i aria-hidden="true">/</i> : null}</span>)}</nav> : null}
      {directory ? <section className="sharedCollection"><ExplorerCollection view={preferences.defaultView} entries={directory.items} selectedIds={new Set()} admin={false} handlers={handlers} onSelectAll={() => undefined} onReplaceSelection={() => undefined} onClearSelection={() => undefined} fileUrlFor={urlFor} /></section> : <button className="sharedFileButton button" onClick={() => setPreview(meta.entry)}>{t('action.preview')}</button>}
    </main>;
  }

  return <AppShell admin={false} contentId="shared-content" publicView onHome={() => undefined} onStorage={() => undefined} onSignIn={() => undefined} onSignOut={() => undefined}>{content}
    {menu && !mobileActions ? <EntryActionMenu entry={menu.entry} anchor={menu.anchor} actions={currentEntryActions} onClose={() => setMenu(null)} /> : null}
    {menu && mobileActions ? <MobileActionSheet open title={t('entry.actions', { name: menu.entry.name })} anchor={menu.anchor} actions={currentEntryActions} translate={t} cancelLabel={t('action.cancel')} onClose={() => setMenu(null)} /> : null}
    {preview ? <PreviewOverlay entry={preview} onClose={() => setPreview(null)} urlFor={urlFor} allowDownload={meta?.allowDownload ?? false} /> : null}
  </AppShell>;
}
