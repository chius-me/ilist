import { CirclePower, Cloud, Link, Link2Off, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createMount, disconnectMount, listMounts, oneDriveConnectUrl, removeMount, testMount, updateMount } from '../../api/mounts';
import { useI18n } from '../../i18n/I18nProvider';
import type { Mount, MountInput } from '../../types/mounts';
import { MountDialog } from './MountDialog';

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMounts(await listMounts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('mount.unableLoad'));
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
      setError(cause instanceof Error ? cause.message : t('mount.unableSave'));
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
      setNotice(cause instanceof Error ? cause.message : t('mount.updateFailed'));
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
      setNotice(cause instanceof Error ? cause.message : t('mount.connectionFailed'));
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
      setNotice(cause instanceof Error ? cause.message : t('mount.deleteFailed'));
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
      setNotice(cause instanceof Error ? cause.message : t('mount.disconnectFailed'));
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
          <details className="mountActionMenu"><summary className="iconButton" role="button" aria-label={t('mount.actionsFor', { name: mount.name })} title={t('mount.columnActions')}><MoreHorizontal aria-hidden="true" size={17} /></summary><div>
            {mount.driverType === 'onedrive' ? <>
              <button type="button" onClick={() => navigate(oneDriveConnectUrl(mount.id))}><Link aria-hidden="true" size={16} />{mount.connected ? t('mount.reconnect') : t('mount.connect')}</button>
              {mount.connected ? <button type="button" onClick={() => setDisconnecting(mount)}><Link2Off aria-hidden="true" size={16} />{t('mount.disconnect')}</button> : null}
            </> : <button type="button" onClick={() => void test(mount)}><RefreshCw aria-hidden="true" size={16} />{t('mount.test')}</button>}
            <button type="button" disabled={busy} onClick={() => void toggle(mount)}><CirclePower aria-hidden="true" size={16} />{mount.enabled ? t('mount.disable') : t('mount.enable')}</button>
            <button type="button" onClick={() => setEditing(mount)}><Pencil aria-hidden="true" size={16} />{t('mount.edit')}</button>
            <button className="destructive" type="button" onClick={() => setDeleting(mount)}><Trash2 aria-hidden="true" size={16} />{t('mount.delete')}</button>
          </div></details>
        </td>
      </tr>)}</tbody>
    </table></div> : null}
    {editing !== undefined ? <MountDialog mount={editing} busy={busy} error={error} onClose={() => { setEditing(undefined); setError(null); }} onSubmit={save} /> : null}
    {deleting ? <div className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={() => setDeleting(null)}><section className="confirmDialog overlaySurface" role="dialog" aria-modal="true" aria-label={t('mount.deleteDialogTitle')} onMouseDown={(event) => event.stopPropagation()}><h2>{t('mount.deleteDialogTitle')}</h2><p>{t('mount.deleteDialogMessage', { name: deleting.name })}</p><footer><button className="button" onClick={() => setDeleting(null)}>{t('action.cancel')}</button><button className="button danger" disabled={busy} onClick={() => void confirmDelete()}>{t('mount.deleteConfirm')}</button></footer></section></div> : null}
    {disconnecting ? <div className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={() => setDisconnecting(null)}><section className="confirmDialog overlaySurface" role="dialog" aria-modal="true" aria-label={t('mount.disconnectDialogTitle')} onMouseDown={(event) => event.stopPropagation()}><h2>{t('mount.disconnectDialogTitle')}</h2><p>{t('mount.disconnectDialogMessage', { name: disconnecting.name })}</p><footer><button className="button" onClick={() => setDisconnecting(null)}>{t('action.cancel')}</button><button className="button danger" disabled={busy} onClick={() => void confirmDisconnect()}>{t('mount.disconnectConfirm')}</button></footer></section></div> : null}
  </main>;
}
