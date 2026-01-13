import { Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFeedbackI18n } from '../../components/ToastRegion';
import { useModalFocus } from '../../hooks/useModalFocus';
import { localizedApiError } from '../../i18n/apiErrors';
import type { Entry } from '../../types/entries';

export function DeleteDialog({ entries, onClose, onSubmit }: { entries: Entry[]; onClose: () => void; onSubmit: () => Promise<void> }) {
  const { formatBytes, t } = useFeedbackI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useModalFocus({ active: true, containerRef: backdrop, initialFocusRef: cancel, onClose });
  const files = entries.filter((entry) => entry.kind === 'file');
  const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (reason) {
      setError(localizedApiError(reason, t, 'dialog.unableDelete'));
    } finally {
      setBusy(false);
    }
  }
  const label = entries.length === 1 ? t('dialog.deleteTitle', { name: entries[0].name }) : t('dialog.deleteCountTitle', { count: entries.length });
  return <div ref={backdrop} className="dialogBackdrop overlayScrim" onMouseDown={onClose}>
    <section className="operationDialog overlaySurface" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialogHeader overlayHeader"><h2>{label}</h2><button className="iconButton" type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X aria-hidden="true" size={17} /></button></header>
      <div className="dialogBody overlayBody">
        <p>{t('dialog.deleteMessage', { count: entries.length })}</p>
        {files.length ? <p>{t('dialog.deleteFiles', { bytes: formatBytes(bytes) })}</p> : null}
        {error ? <p className="formError" role="alert">{error}</p> : null}
        <footer className="dialogButtons overlayFooter"><button ref={cancel} className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button danger" type="button" onClick={() => void remove()} disabled={busy}><Trash2 aria-hidden="true" size={16} />{busy ? t('dialog.deleting') : t('action.delete')}</button></footer>
      </div>
    </section>
  </div>;
}
