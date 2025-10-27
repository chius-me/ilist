import { ArrowLeft, CirclePower, Cloud, Link, Link2Off, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createMount, disconnectMount, listMounts, oneDriveConnectUrl, removeMount, testMount, updateMount } from '../../api/mounts';
import type { Mount, MountInput } from '../../types/mounts';
import { MountDialog } from './MountDialog';

export function MountManager({ onBack, navigate = (url) => window.location.assign(url) }: { onBack: () => void; navigate?: (url: string) => void }) {
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Mount | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Mount | null>(null);
  const [disconnecting, setDisconnecting] = useState<Mount | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setMounts(await listMounts()); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load storage mounts'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const status = new URL(window.location.href).searchParams.get('onedrive');
    if (status === 'connected') setNotice('OneDrive connected');
    if (status === 'error') setNotice('OneDrive connection failed');
  }, []);

  async function save(input: MountInput) {
    setBusy(true); setError(null);
    try {
      if (editing) await updateMount(editing.id, input);
      else {
        const created = await createMount(input);
        if (input.driverType === 'onedrive') { navigate(oneDriveConnectUrl(created.id)); return; }
      }
      setEditing(undefined); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save storage'); } finally { setBusy(false); }
  }

  async function toggle(mount: Mount) {
    setBusy(true);
    try { await updateMount(mount.id, { enabled: !mount.enabled }); await refresh(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Update failed'); } finally { setBusy(false); }
  }

  async function test(mount: Mount) {
    setNotice(null);
    try { await testMount(mount.id); setNotice('Connection successful'); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Connection failed'); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try { await removeMount(deleting.id); setDeleting(null); await refresh(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Delete failed'); } finally { setBusy(false); }
  }

  async function confirmDisconnect() {
    if (!disconnecting) return;
    setBusy(true);
    try { await disconnectMount(disconnecting.id); setDisconnecting(null); setNotice('OneDrive disconnected'); await refresh(); } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Disconnect failed'); } finally { setBusy(false); }
  }

  return <main className="storageManager" id="storage-manager">
    <header className="storageManagerHeader"><div><button className="backButton" type="button" onClick={onBack}><ArrowLeft size={16} />Files</button><h1>Storage mounts</h1><p>Manage S3-compatible buckets and connected drives.</p></div><button className="button primary" type="button" onClick={() => setEditing(null)}><Plus size={16} />Add storage</button></header>
    {notice ? <div className="operationNotice" role="status">{notice}</div> : null}
    {error && editing === undefined ? <div className="errorState" role="alert"><strong>Unable to load storage mounts</strong><span>{error}</span><button className="button" onClick={() => void refresh()}><RefreshCw size={16} />Retry</button></div> : null}
    {loading ? <div className="mountLoading" aria-label="Loading storage mounts">Loading...</div> : null}
    {!loading && !error && mounts.length === 0 ? <div className="mountEmpty"><Cloud size={30} /><strong>No storage mounts</strong><span>Add an S3-compatible bucket to begin.</span></div> : null}
    <div className="mountList">{mounts.map((mount) => <article className="mountRow" key={mount.id}>
      <div className="mountProvider"><Cloud size={20} /><div><strong>{mount.name}</strong><span>{mount.mountPath}</span></div></div>
      <div className="mountDetails"><span>{mount.driverType === 'onedrive' ? 'OneDrive Personal' : mount.provider}</span><span>{mount.driverType === 'onedrive' ? (mount.connected ? 'Connected' : 'Not connected') : String(mount.config.bucket ?? '')}</span><span className={mount.enabled ? 'statusOnline' : 'statusOffline'}>{mount.enabled ? 'Enabled' : 'Disabled'}</span></div>
      <div className="mountActions">
        {mount.driverType === 'onedrive' ? <>
          <button className="iconButton" title={mount.connected ? 'Reconnect' : 'Connect'} aria-label={`${mount.connected ? 'Reconnect' : 'Connect'} ${mount.name}`} onClick={() => navigate(oneDriveConnectUrl(mount.id))}><Link size={16} /></button>
          {mount.connected ? <button className="iconButton" title="Disconnect" aria-label={`Disconnect ${mount.name}`} onClick={() => setDisconnecting(mount)}><Link2Off size={16} /></button> : null}
        </> : <button className="iconButton" title="Test connection" aria-label={`Test ${mount.name}`} onClick={() => void test(mount)}><RefreshCw size={16} /></button>}
        <button className="iconButton" title={mount.enabled ? 'Disable' : 'Enable'} aria-label={`${mount.enabled ? 'Disable' : 'Enable'} ${mount.name}`} disabled={busy} onClick={() => void toggle(mount)}><CirclePower size={16} /></button>
        <button className="iconButton" title="Edit" aria-label={`Edit ${mount.name}`} onClick={() => setEditing(mount)}><Pencil size={16} /></button>
        <button className="iconButton danger" title="Delete" aria-label={`Delete ${mount.name}`} onClick={() => setDeleting(mount)}><Trash2 size={16} /></button>
      </div>
    </article>)}</div>
    {editing !== undefined ? <MountDialog mount={editing} busy={busy} error={error} onClose={() => { setEditing(undefined); setError(null); }} onSubmit={save} /> : null}
    {deleting ? <div className="dialogBackdrop" role="presentation" onMouseDown={() => setDeleting(null)}><section className="confirmDialog" role="dialog" aria-modal="true" aria-label="Delete storage mount" onMouseDown={(event) => event.stopPropagation()}><h2>Delete storage mount</h2><p>Remove <strong>{deleting.name}</strong> from ilist? Remote files will not be deleted.</p><footer><button className="button secondary" onClick={() => setDeleting(null)}>Cancel</button><button className="button dangerButton" disabled={busy} onClick={() => void confirmDelete()}>Delete mount</button></footer></section></div> : null}
    {disconnecting ? <div className="dialogBackdrop" role="presentation" onMouseDown={() => setDisconnecting(null)}><section className="confirmDialog" role="dialog" aria-modal="true" aria-label="Disconnect OneDrive" onMouseDown={(event) => event.stopPropagation()}><h2>Disconnect OneDrive</h2><p>Remove the saved Microsoft authorization for <strong>{disconnecting.name}</strong>? Remote files will not be changed.</p><footer><button className="button secondary" onClick={() => setDisconnecting(null)}>Cancel</button><button className="button dangerButton" disabled={busy} onClick={() => void confirmDisconnect()}>Disconnect account</button></footer></section></div> : null}
  </main>;
}
