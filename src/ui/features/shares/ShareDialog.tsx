import { Check, Copy, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useModalFocus } from '../../hooks/useModalFocus';
import { useI18n } from '../../i18n/I18nProvider';
import type { Entry } from '../../types/entries';
import type { CreatedShare, CreateShareInput, ShareView, UpdateShareInput } from '../../types/shares';

type Props = {
  entry?: Entry;
  share?: ShareView;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onCreate?: (input: CreateShareInput) => Promise<CreatedShare>;
  onUpdate?: (input: UpdateShareInput) => Promise<void>;
};

function localDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function ShareDialog({ entry, share, busy, error, onClose, onCreate, onUpdate }: Props) {
  const { t } = useI18n();
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: closeButton, onClose });
  const [allowDownload, setAllowDownload] = useState(share?.allowDownload ?? true);
  const [enabled, setEnabled] = useState(share?.enabled ?? true);
  const [protectedShare, setProtectedShare] = useState(share?.protected ?? false);
  const [password, setPassword] = useState('');
  const [expiring, setExpiring] = useState(Boolean(share?.expiresAt));
  const [expiresAt, setExpiresAt] = useState(localDateTime(share?.expiresAt));
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const expiration = expiring && expiresAt ? new Date(expiresAt).toISOString() : undefined;
      if (entry && onCreate) {
        setCreated(await onCreate({
          entryId: entry.id,
          allowDownload,
          enabled,
          ...(protectedShare ? { password } : {}),
          ...(expiration ? { expiresAt: expiration } : {}),
        }));
        return;
      }
      if (share && onUpdate) {
        await onUpdate({
          allowDownload,
          enabled,
          ...(protectedShare && password ? { password } : {}),
          ...(!protectedShare && share.protected ? { clearPassword: true } : {}),
          expiresAt: expiration ?? null,
        });
        onClose();
      }
    } catch {
      // The owner supplies localized error state and keeps the dialog open.
    }
  }

  async function copyLink() {
    if (!created) return;
    await navigator.clipboard.writeText(created.url);
    setCopied(true);
  }

  return <div ref={backdrop} className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={onClose}>
    <section className="shareDialog overlaySurface" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="overlayHeader"><h2 id="share-dialog-title">{created ? t('share.createdTitle') : share ? t('share.editTitle') : t('share.createTitle')}</h2><button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label={t('common.close')}><X aria-hidden="true" size={18} /></button></header>
      {created ? <div className="shareResult overlayBody">
        <p>{t('share.oneTimeHint')}</p>
        <label>{t('share.link')}<span className="shareLinkField"><input readOnly value={created.url} aria-label={t('share.link')} /><button className="iconButton" type="button" onClick={() => void copyLink()} aria-label={t('share.copyLink')} title={t('share.copyLink')}>{copied ? <Check aria-hidden="true" size={17} /> : <Copy aria-hidden="true" size={17} />}</button></span></label>
        <footer className="overlayFooter"><button className="button primary" type="button" onClick={onClose}>{t('common.close')}</button></footer>
      </div> : <form onSubmit={(event) => void submit(event)}>
        <div className="overlayBody sharePolicyForm">
          <strong>{entry?.name ?? share?.name}</strong>
          <label className="checkboxLabel"><input type="checkbox" checked={allowDownload} onChange={(event) => setAllowDownload(event.target.checked)} />{t('share.allowDownload')}</label>
          <label className="checkboxLabel"><input type="checkbox" checked={protectedShare} onChange={(event) => setProtectedShare(event.target.checked)} />{t('share.requirePassword')}</label>
          {protectedShare ? <label>{t('share.password')}<input type="password" minLength={8} required={!share?.protected} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={share?.protected ? t('share.keepPassword') : ''} /></label> : null}
          <label className="checkboxLabel"><input type="checkbox" checked={expiring} onChange={(event) => setExpiring(event.target.checked)} />{t('share.setExpiration')}</label>
          {expiring ? <label>{t('share.expiresAt')}<input type="datetime-local" required value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label> : null}
          {share ? <label className="checkboxLabel"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t('common.enabled')}</label> : null}
          {error ? <div className="formError" role="alert">{error}</div> : null}
        </div>
        <footer className="overlayFooter"><button className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button primary" type="submit" disabled={busy}>{share ? t('common.save') : t('share.create')}</button></footer>
      </form>}
    </section>
  </div>;
}
