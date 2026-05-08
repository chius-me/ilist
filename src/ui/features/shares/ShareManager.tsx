import { CirclePower, Pencil, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteShare, listShares, updateShare } from '../../api/shares';
import { useModalFocus } from '../../hooks/useModalFocus';
import { useI18n } from '../../i18n/I18nProvider';
import { localizedApiError } from '../../i18n/apiErrors';
import type { ShareView, UpdateShareInput } from '../../types/shares';
import { ShareDialog } from './ShareDialog';

function DeleteShareDialog({ share, busy, onClose, onConfirm }: { share: ShareView; busy: boolean; onClose(): void; onConfirm(): void }) {
  const { t } = useI18n();
  const backdrop = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: cancel, onClose });
  return <div ref={backdrop} className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={onClose}><section className="confirmDialog overlaySurface" role="dialog" aria-modal="true" aria-label={t('share.deleteTitle')} onMouseDown={(event) => event.stopPropagation()}><h2>{t('share.deleteTitle')}</h2><p>{t('share.deleteMessage', { name: share.name })}</p><footer><button ref={cancel} className="button" onClick={onClose}>{t('action.cancel')}</button><button className="button danger" disabled={busy} onClick={onConfirm}>{t('share.delete')}</button></footer></section></div>;
}

export function ShareManager() {
  const { t, formatDate } = useI18n();
  const [shares, setShares] = useState<ShareView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShareView | null>(null);
  const [deleting, setDeleting] = useState<ShareView | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setShares(await listShares()); }
    catch (cause) { setError(localizedApiError(cause, t, 'share.unableLoad')); }
    finally { setLoading(false); }
  }, [t]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function patch(id: string, input: UpdateShareInput) {
    setBusy(true); setError(null);
    try { const updated = await updateShare(id, input); setShares((current) => current.map((item) => item.id === id ? updated : item)); }
    catch (cause) { setError(localizedApiError(cause, t, 'share.unableSave')); throw cause; }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try { await deleteShare(deleting.id); setShares((current) => current.filter((item) => item.id !== deleting.id)); setDeleting(null); }
    catch (cause) { setError(localizedApiError(cause, t, 'share.unableDelete')); }
    finally { setBusy(false); }
  }

  return <main className="shareManager" id="share-manager">
    <header className="adminPageHeader"><div><h1>{t('admin.sharesTitle')}</h1><p>{t('admin.sharesDescription')}</p></div></header>
    {error && !editing ? <div className="errorState" role="alert"><strong>{error}</strong><button className="button" onClick={() => void refresh()}><RefreshCw aria-hidden="true" size={16} />{t('action.retry')}</button></div> : null}
    {loading ? <div className="mountLoading">{t('share.loading')}</div> : null}
    {!loading && !error && shares.length === 0 ? <div className="mountEmpty"><Share2 aria-hidden="true" size={30} /><strong>{t('share.empty')}</strong><span>{t('share.emptyHint')}</span></div> : null}
    {!loading && shares.length ? <div className="mountTableWrap"><table className="mountTable shareTable" aria-label={t('admin.sharesTitle')}><thead><tr><th>{t('share.target')}</th><th>{t('share.policy')}</th><th>{t('share.expiration')}</th><th>{t('share.state')}</th><th><span className="srOnly">{t('share.actions')}</span></th></tr></thead><tbody>{shares.map((item) => <tr key={item.id}>
      <th scope="row"><span className="mountIdentity"><Share2 aria-hidden="true" size={19} /><span><strong>{item.name}</strong><small>{item.mountName}</small></span></span></th>
      <td><span className="sharePolicySummary">{item.protected ? t('share.passwordProtected') : t('share.noPassword')}<small>{item.allowDownload ? t('share.downloadAllowed') : t('share.downloadBlocked')}</small></span></td>
      <td>{item.expiresAt ? formatDate(item.expiresAt) : t('share.never')}</td>
      <td><span className={item.enabled ? 'statusOnline' : 'statusOffline'}>{item.enabled ? t('common.enabled') : t('common.disabled')}</span></td>
      <td className="shareActions"><button className="iconButton" type="button" aria-label={t('share.editFor', { name: item.name })} onClick={() => setEditing(item)}><Pencil aria-hidden="true" size={16} /></button><button className="iconButton" type="button" aria-label={item.enabled ? t('share.disableFor', { name: item.name }) : t('share.enableFor', { name: item.name })} onClick={() => void patch(item.id, { enabled: !item.enabled }).catch(() => undefined)}><CirclePower aria-hidden="true" size={16} /></button><button className="iconButton dangerIcon" type="button" aria-label={t('share.deleteFor', { name: item.name })} onClick={() => setDeleting(item)}><Trash2 aria-hidden="true" size={16} /></button></td>
    </tr>)}</tbody></table></div> : null}
    {editing ? <ShareDialog share={editing} busy={busy} error={error} onClose={() => { setEditing(null); setError(null); }} onUpdate={(input) => patch(editing.id, input)} /> : null}
    {deleting ? <DeleteShareDialog share={deleting} busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} /> : null}
  </main>;
}
