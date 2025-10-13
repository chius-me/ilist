import { ChevronRight, Folder, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { entryPath, listDirectory } from '../../api/entries';
import type { DirectoryResponse, Entry } from '../../types/entries';

function canAcceptMove(directory: DirectoryResponse | null): boolean {
  if (!directory || directory.current.kind !== 'folder') return false;
  const { move, upload, createFolder } = directory.current.capabilities;
  return move || upload || createFolder;
}

export function FolderPickerDialog({ entries, onClose, onSubmit }: { entries: Entry[]; onClose: () => void; onSubmit: (destinationId: string) => Promise<void> }) {
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null); const [path, setPath] = useState('/'); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; closeButton.current?.focus(); const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', closeOnEscape); return () => { document.removeEventListener('keydown', closeOnEscape); previous?.focus(); }; }, [onClose]);
  useEffect(() => { let active = true; setDirectory(null); setError(null); void listDirectory(path).then((value) => { if (active) setDirectory(value); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load folders.'); }); return () => { active = false; }; }, [path]);
  const selected = new Set(entries.map((entry) => entry.id));
  const canMoveHere = canAcceptMove(directory);
  async function move() { if (!directory || !canMoveHere || selected.has(directory.current.id)) return; setBusy(true); setError(null); try { await onSubmit(directory.current.id); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to move.'); } finally { setBusy(false); } }
  return <div className="dialogBackdrop" onMouseDown={onClose}><section className="operationDialog" role="dialog" aria-modal="true" aria-label="Move selected entries" onMouseDown={(event) => event.stopPropagation()}><div className="dialogHeader"><h2>Move {entries.length === 1 ? entries[0].name : `${entries.length} entries`}</h2><button ref={closeButton} className="iconButton" type="button" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={17} /></button></div><div className="dialogBody"><nav className="pickerBreadcrumbs" aria-label="Destination path">{directory?.breadcrumbs.map((crumb) => <button key={crumb.id} type="button" onClick={() => setPath(crumb.path)}>{crumb.name}<ChevronRight aria-hidden="true" size={14} /></button>)}</nav><div className="folderPicker" aria-busy={!directory}>{directory?.items.filter((entry) => entry.kind === 'folder').map((entry) => <button key={entry.id} type="button" disabled={selected.has(entry.id)} onClick={() => setPath(entryPath(path, entry))}><Folder aria-hidden="true" size={17} />{entry.name}</button>)}{directory && directory.items.every((entry) => entry.kind !== 'folder') ? <span>No folders here.</span> : null}</div>{error ? <p className="formError" role="alert">{error}</p> : null}<div className="dialogButtons"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="button" onClick={() => void move()} disabled={!directory || !canMoveHere || selected.has(directory.current.id) || busy}>{busy ? 'Moving' : 'Move here'}</button></div></div></section></div>;
}
