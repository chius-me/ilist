import { ChevronRight, Folder, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { entryPath, listDirectory } from '../../api/entries';
import { useFeedbackI18n } from '../../components/ToastRegion';
import type { DirectoryResponse, Entry } from '../../types/entries';

function canAcceptMove(directory: DirectoryResponse | null): boolean {
  if (!directory || directory.current.kind !== 'folder') return false;
  const { move, upload, createFolder } = directory.current.capabilities;
  return move || upload || createFolder;
}

export function FolderPickerDialog({ entries, onClose, onSubmit }: { entries: Entry[]; onClose: () => void; onSubmit: (destinationId: string) => Promise<void> }) {
  const { locale, t } = useFeedbackI18n();
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [path, setPath] = useState('/');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('keydown', closeOnEscape); previous?.focus(); };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    setDirectory(null);
    setError(null);
    void listDirectory(path).then((value) => { if (active) setDirectory(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : t('dialog.unableLoadFolders')); });
    return () => { active = false; };
  }, [locale, path, refreshVersion]);
  const selected = new Set(entries.map((entry) => entry.id));
  const canMoveHere = canAcceptMove(directory);
  async function move() {
    if (!directory || !canMoveHere || selected.has(directory.current.id)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(directory.current.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('dialog.unableMove'));
    } finally {
      setBusy(false);
    }
  }
  const title = entries.length === 1 ? t('dialog.moveTitle', { name: entries[0].name }) : t('dialog.moveCountTitle', { count: entries.length });
  return <div className="dialogBackdrop overlayScrim" onMouseDown={onClose}>
    <section className="operationDialog overlaySurface" role="dialog" aria-modal="true" aria-label={t('dialog.moveSelected')} onMouseDown={(event) => event.stopPropagation()}>
      <header className="dialogHeader overlayHeader"><h2>{title}</h2><button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X aria-hidden="true" size={17} /></button></header>
      <div className="dialogBody overlayBody">
        <nav className="pickerBreadcrumbs" aria-label={t('dialog.destinationPath')}>{directory?.breadcrumbs.map((crumb) => <button key={crumb.id} type="button" onClick={() => setPath(crumb.path)}>{crumb.name}<ChevronRight aria-hidden="true" size={14} /></button>)}</nav>
        <div className="folderPicker" aria-busy={!directory && !error}>{directory?.items.filter((entry) => entry.kind === 'folder').map((entry) => <button key={entry.id} type="button" disabled={selected.has(entry.id)} onClick={() => setPath(entryPath(path, entry))}><Folder aria-hidden="true" size={17} />{entry.name}</button>)}{directory && directory.items.every((entry) => entry.kind !== 'folder') ? <span>{t('dialog.noFolders')}</span> : null}</div>
        {error ? <div className="inlineError" role="alert"><span>{error}</span><button className="button" type="button" onClick={() => setRefreshVersion((value) => value + 1)}><RefreshCw aria-hidden="true" size={15} />{t('action.retry')}</button></div> : null}
        <footer className="dialogButtons overlayFooter"><button className="button" type="button" onClick={onClose}>{t('action.cancel')}</button><button className="button primary" type="button" onClick={() => void move()} disabled={!directory || !canMoveHere || selected.has(directory.current.id) || busy}>{busy ? t('dialog.moving') : t('dialog.moveHere')}</button></footer>
      </div>
    </section>
  </div>;
}
