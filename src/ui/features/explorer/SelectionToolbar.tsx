import { CopyPlus, Eye, EyeOff, FolderInput, Trash2, X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';

export function SelectionToolbar({
  count,
  pending,
  canMove = true,
  canCopy = true,
  canPublish = true,
  canHide = true,
  canDelete = true,
  onMove,
  onCopy,
  onPublish,
  onHide,
  onDelete,
  onClear,
}: {
  count: number;
  pending: boolean;
  canMove?: boolean;
  canCopy?: boolean;
  canPublish?: boolean;
  canHide?: boolean;
  canDelete?: boolean;
  onMove: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onHide: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return <section className="selectionToolbar" aria-label={t('selection.actions')}>
    <strong>{t('selection.count', { count })}</strong>
    <div className="selectionActions">
      {canMove ? <button className="button" type="button" onClick={onMove} disabled={pending}><FolderInput aria-hidden="true" size={16} />{t('action.move')}</button> : null}
      {canCopy ? <button className="button" type="button" onClick={onCopy} disabled={pending}><CopyPlus aria-hidden="true" size={16} />{t('action.copyTo')}</button> : null}
      {canPublish ? <button className="button" type="button" onClick={onPublish} disabled={pending}><Eye aria-hidden="true" size={16} />{t('selection.publish')}</button> : null}
      {canHide ? <button className="button" type="button" onClick={onHide} disabled={pending}><EyeOff aria-hidden="true" size={16} />{t('selection.hide')}</button> : null}
      {canDelete ? <button className="button danger" type="button" onClick={onDelete} disabled={pending}><Trash2 aria-hidden="true" size={16} />{t('action.delete')}</button> : null}
      <button className="iconButton" type="button" onClick={onClear} disabled={pending} aria-label={t('selection.clear')} title={t('selection.clear')}><X aria-hidden="true" size={17} /></button>
    </div>
  </section>;
}
