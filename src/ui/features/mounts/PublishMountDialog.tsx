import { useRef } from 'react';
import { useModalFocus } from '../../hooks/useModalFocus';
import { useI18n } from '../../i18n/I18nProvider';

interface Props {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PublishMountDialog({ busy, onCancel, onConfirm }: Props) {
  const { t } = useI18n();
  const backdrop = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useModalFocus({ containerRef: backdrop, initialFocusRef: cancel, onClose: onCancel });

  return <div ref={backdrop} className="dialogBackdrop overlayScrim" role="presentation" onMouseDown={onCancel}>
    <section className="confirmDialog overlaySurface" role="dialog" aria-modal="true" aria-labelledby="publish-mount-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <h2 id="publish-mount-dialog-title">{t('mount.publishDialogTitle')}</h2>
      <p>{t('mount.publishDialogMessage')}</p>
      <footer>
        <button ref={cancel} className="button" type="button" onClick={onCancel}>{t('action.cancel')}</button>
        <button className="button primary" type="button" disabled={busy} onClick={onConfirm}>{t('mount.publishConfirm')}</button>
      </footer>
    </section>
  </div>;
}
