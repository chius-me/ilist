import { X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import { useModalFocus } from '../../hooks/useModalFocus';
import { localizedApiError } from '../../i18n/apiErrors';
import type { Entry, EntryPatch } from '../../types/entries';

export function PropertiesDialog({ entry, onClose, onSubmit }: { entry: Entry; onClose: () => void; onSubmit: (patch: EntryPatch) => Promise<void> }) {
  const { t } = useFeedbackI18n();
  const [description, setDescription] = useState(entry.description);
  const [sortOrder, setSortOrder] = useState(String(entry.sortOrder));
  const [isPublic, setPublic] = useState(entry.isPublic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: closeButton, onClose });
  useEffect(() => { setDescription(entry.description); setSortOrder(String(entry.sortOrder)); setPublic(entry.isPublic); }, [entry]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ description, sortOrder: Number(sortOrder) || 0, isPublic });
      onClose();
    } catch (reason) {
      setError(localizedApiError(reason, t, 'dialog.unableSaveProperties'));
    } finally {
      setBusy(false);
    }
  }
  const label = t('dialog.propertiesFor', { name: entry.name });
  return <div ref={backdrop} className="dialogBackdrop overlayScrim" onMouseDown={onClose}>
    <section className="operationDialog overlaySurface" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialogHeader overlayHeader"><h2>{t('dialog.properties')}</h2><button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X aria-hidden="true" size={17} /></button></header>
      <form className="overlayBody" onSubmit={submit}>
        <label>{t('dialog.description')}<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>{t('dialog.sortOrder')}<input type="number" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} /></label>
        <label className="checkboxLabel"><input type="checkbox" checked={isPublic} onChange={(event) => setPublic(event.target.checked)} />{t('dialog.public')}</label>
        {error ? <p className="formError" role="alert">{error}</p> : null}
        <footer className="dialogButtons overlayFooter"><button className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button primary" type="submit" disabled={busy}>{busy ? t('dialog.saving') : t('common.save')}</button></footer>
      </form>
    </section>
  </div>;
}
