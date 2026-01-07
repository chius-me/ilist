import { X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useFeedbackI18n } from '../../components/ToastRegion';

export function RenameDialog({ open, title, initialName = '', submitLabel, onClose, onSubmit }: {
  open: boolean; title?: string; initialName?: string; submitLabel?: string; onClose: () => void; onSubmit: (name: string) => Promise<void>;
}) {
  const { t } = useFeedbackI18n();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dialogTitle = title ?? t('action.rename');
  useEffect(() => {
    if (open) {
      setName(initialName);
      setError(null);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open, initialName]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('keydown', closeOnEscape); previous?.focus(); };
  }, [onClose, open]);
  if (!open) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError(t('dialog.enterName')); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (reason) {
      setError(reason instanceof ApiError && reason.code === 'ENTRY_NAME_CONFLICT' ? t('dialog.nameConflict') : reason instanceof Error ? reason.message : t('dialog.unableSave'));
    } finally {
      setBusy(false);
    }
  }
  return <div className="dialogBackdrop overlayScrim" onMouseDown={onClose}>
    <section className="operationDialog overlaySurface" role="dialog" aria-modal="true" aria-label={dialogTitle} onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialogHeader overlayHeader"><h2>{dialogTitle}</h2><button className="iconButton" type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X aria-hidden="true" size={17} /></button></header>
      <form className="overlayBody" onSubmit={submit}>
        <label>{t('dialog.name')}<input ref={input} value={name} onChange={(event) => setName(event.target.value)} /></label>
        {error ? <p className="formError" role="alert">{error}</p> : null}
        <footer className="dialogButtons overlayFooter"><button className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button primary" type="submit" disabled={busy}>{busy ? t('dialog.saving') : submitLabel ?? t('common.save')}</button></footer>
      </form>
    </section>
  </div>;
}
