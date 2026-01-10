import { CirclePower, Cloud, Link, Link2Off, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createMount, disconnectMount, listMounts, oneDriveConnectUrl, removeMount, testMount, updateMount } from '../../api/mounts';
import { useI18n } from '../../i18n/I18nProvider';
import type { Mount, MountInput } from '../../types/mounts';
import { MountDialog } from './MountDialog';
import { useModalFocus } from '../../hooks/useModalFocus';
import { localizedApiError } from '../../i18n/apiErrors';

interface MountManagerProps {
  onBack: () => void;
  navigate?: (url: string) => void;
}

function providerName(mount: Mount, t: ReturnType<typeof useI18n>['t']): string {
  if (mount.driverType === 'onedrive') return t('mount.providerOneDrive');
  if (mount.provider === 'cloudflare-r2') return 'Cloudflare R2';
  if (mount.provider === 'aws-s3') return 'AWS S3';
  if (mount.provider === 'backblaze-b2') return 'Backblaze B2';
  return mount.provider;
}

function MountConfirmation({ label, message, confirmLabel, busy, onClose, onConfirm }: {
  label: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const backdrop = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalFocus({ containerRef: backdrop, initialFocusRef: cancel, onClose });
  return <div ref={backdrop} className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={onClose}>
    <section className="confirmDialog overlaySurface" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => event.stopPropagation()}>
      <h2>{label}</h2><p>{message}</p><footer><button ref={cancel} className="button" onClick={onClose}>{t('action.cancel')}</button><button className="button danger" disabled={busy} onClick={onConfirm}>{confirmLabel}</button></footer>
    </section>
  </div>;
}

export function MountManager(props: MountManagerProps) {
  const navigate = props.navigate ?? ((url: string) => window.location.assign(url));
  const { t } = useI18n();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Mount | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Mount | null>(null);
  const [disconnecting, setDisconnecting] = useState<Mount | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  function selectMountAction(event: MouseEvent<HTMLButtonElement>, action: () => void) {
    const details = event.currentTarget.closest('details');
    const summary = details?.querySelector<HTMLElement>('summary');
    if (details) details.open = false;
    setOpenMenuId(null);
    summary?.focus();
    action();
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMounts(await listMounts());
    } catch (cause) {
      setError(localizedApiError(cause, t, 'mount.unableLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const status = new URL(window.location.href).searchParams.get('onedrive');
    if (status === 'connected') setNotice(t('mount.oneDriveConnected'));
    if (status === 'error') setNotice(t('mount.oneDriveConnectionFailed'));
  }, [t]);

  async function save(input: MountInput) {
    setBusy(true);
    setError(null);
    try {
      if (editing) await updateMount(editing.id, input);
      else {
        const created = await createMount(input);
        if (input.driverType === 'onedrive') { navigate(oneDriveConnectUrl(created.id)); return; }
      }
      setEditing(undefined);
      await refresh();
    } catch (cause) {
      setError(localizedApiError(cause, t, 'mount.unableSave'));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(mount: Mount) {
    setBusy(true);
    try {
      await updateMount(mount.id, { enabled: !mount.enabled });
      await refresh();
    } catch (cause) {
      setNotice(localizedApiError(cause, t, 'mount.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function test(mount: Mount) {
    setNotice(null);
    try {
      await testMount(mount.id);
      setNotice(t('mount.connectionSuccessful'));
    } catch (cause) {
      setNotice(localizedApiError(cause, t, 'mount.connectionFailed'));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await removeMount(deleting.id);
      setDeleting(null);
      await refresh();
    } catch (cause) {
      setNotice(localizedApiError(cause, t, 'mount.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisconnect() {
    if (!disconnecting) return;
    setBusy(true);
    try {
      await disconnectMount(disconnecting.id);
      setDisconnecting(null);
      setNotice(t('mount.oneDriveDisconnected'));
      await refresh();
    } catch (cause) {
      setNotice(localizedApiError(cause, t, 'mount.disconnectFailed'));
    } finally {
      setBusy(false);
    }
  }

  return <main className="storageManager" id="storage-manager">
    <header className="adminPageHeader storageManagerHeader">
      <div><h1>{t('admin.storageTitle')}</h1><p>{t('admin.storageDescription')}</p></div>
      <button className="button primary" type="button" onClick={() => setEditing(null)}><Plus aria-hidden="true" size={16} />{t('admin.addStorage')}</button>
    </header>
    {notice ? <div className="operationNotice" role="status">{notice}</div> : null}
    {error && editing === undefined ? <div className="errorState" role="alert"><strong>{t('mount.unableLoad')}</strong><span>{error}</span><button className="button" onClick={() => void refresh()}><RefreshCw aria-hidden="true" size={16} />{t('action.retry')}</button></div> : null}
    {loading ? <div className="mountLoading" aria-label={t('mount.loading')}>{t('mount.loading')}</div> : null}
    {!loading && !error && mounts.length === 0 ? <div className="mountEmpty"><Cloud aria-hidden="true" size={30} /><strong>{t('mount.empty')}</strong><span>{t('mount.emptyHint')}</span></div> : null}
    {!loading && mounts.length ? <div className="mountTableWrap"><table className="mountTable" aria-label={t('admin.storageTitle')}>
      <thead><tr><th scope="col">{t('mount.columnName')}</th><th scope="col">{t('mount.columnPath')}</th><th scope="col">{t('mount.columnConnection')}</th><th scope="col">{t('mount.columnState')}</th><th scope="col"><span className="srOnly">{t('mount.columnActions')}</span></th></tr></thead>
      <tbody>{mounts.map((mount) => <tr key={mount.id}>
        <th scope="row" data-label={t('mount.columnName')}><span className="mountIdentity"><Cloud aria-hidden="true" size={20} /><span><strong>{mount.name}</strong><small>{providerName(mount, t)}</small></span></span></th>
        <td data-label={t('mount.columnPath')}><code>{mount.mountPath}</code></td>
        <td data-label={t('mount.columnConnection')}><span className="mountConnection"><span className={mount.connected ? 'statusOnline' : 'statusOffline'}>{mount.connected ? t('mount.connected') : t('mount.notConnected')}</span>{mount.driverType === 's3' && mount.config.bucket ? <small>{String(mount.config.bucket)}</small> : null}</span></td>
        <td data-label={t('mount.columnState')}><span className={mount.enabled ? 'statusOnline' : 'statusOffline'}>{mount.enabled ? t('common.enabled') : t('common.disabled')}</span></td>
        <td className="mountActionCell">
          <details className="mountActionMenu" open={openMenuId === mount.id}><summary className="iconButton" role="button" aria-label={t('mount.actionsFor', { name: mount.name })} title={t('mount.columnActions')} onClick={(event) => {
            event.preventDefault();
            setOpenMenuId((current) => current === mount.id ? null : mount.id);
          }}><MoreHorizontal aria-hidden="true" size={17} /></summary><div>
            {mount.driverType === 'onedrive' ? <>
              <button type="button" onClick={(event) => selectMountAction(event, () => navigate(oneDriveConnectUrl(mount.id)))}><Link aria-hidden="true" size={16} />{mount.connected ? t('mount.reconnect') : t('mount.connect')}</button>
              {mount.connected ? <button type="button" onClick={(event) => selectMountAction(event, () => setDisconnecting(mount))}><Link2Off aria-hidden="true" size={16} />{t('mount.disconnect')}</button> : null}
            </> : <button type="button" onClick={(event) => selectMountAction(event, () => void test(mount))}><RefreshCw aria-hidden="true" size={16} />{t('mount.test')}</button>}
            <button type="button" disabled={busy} onClick={(event) => selectMountAction(event, () => void toggle(mount))}><CirclePower aria-hidden="true" size={16} />{mount.enabled ? t('mount.disable') : t('mount.enable')}</button>
            <button type="button" onClick={(event) => selectMountAction(event, () => setEditing(mount))}><Pencil aria-hidden="true" size={16} />{t('mount.edit')}</button>
            <button className="destructive" type="button" onClick={(event) => selectMountAction(event, () => setDeleting(mount))}><Trash2 aria-hidden="true" size={16} />{t('mount.delete')}</button>
          </div></details>
        </td>
      </tr>)}</tbody>
    </table></div> : null}
    {editing !== undefined ? <MountDialog mount={editing} busy={busy} error={error} onClose={() => { setEditing(undefined); setError(null); }} onSubmit={save} /> : null}
    {deleting ? <MountConfirmation label={t('mount.deleteDialogTitle')} message={t('mount.deleteDialogMessage', { name: deleting.name })} confirmLabel={t('mount.deleteConfirm')} busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void confirmDelete()} /> : null}
    {disconnecting ? <MountConfirmation label={t('mount.disconnectDialogTitle')} message={t('mount.disconnectDialogMessage', { name: disconnecting.name })} confirmLabel={t('mount.disconnectConfirm')} busy={busy} onClose={() => setDisconnecting(null)} onConfirm={() => void confirmDisconnect()} /> : null}
  </main>;
}
