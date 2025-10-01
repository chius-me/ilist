import { Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Entry } from '../../types/entries';

export function DeleteDialog({ entries, onClose, onSubmit }: { entries: Entry[]; onClose: () => void; onSubmit: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; cancel.current?.focus(); const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', closeOnEscape); return () => { document.removeEventListener('keydown', closeOnEscape); previous?.focus(); }; }, [onClose]);
  const files = entries.filter((entry) => entry.kind === 'file'); const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  async function remove() { setBusy(true); setError(null); try { await onSubmit(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete.'); } finally { setBusy(false); } }
  const label = entries.length === 1 ? `Delete ${entries[0].name}` : `Delete ${entries.length} entries`;
  return <div className="dialogBackdrop" onMouseDown={onClose}><section className="operationDialog" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(event) => event.stopPropagation()}><div className="dialogHeader"><h2>{label}</h2><button className="iconButton" type="button" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={17} /></button></div><div className="dialogBody"><p>This will delete {entries.length} selected {entries.length === 1 ? 'entry' : 'entries'}{files.length ? `, including ${bytes} bytes of files` : ''}. Folders are deleted recursively.</p>{error ? <p className="formError" role="alert">{error}</p> : null}<div className="dialogButtons"><button ref={cancel} className="button" type="button" onClick={onClose}>Cancel</button><button className="button danger" type="button" onClick={() => void remove()} disabled={busy}><Trash2 aria-hidden="true" size={16} />{busy ? 'Deleting' : 'Delete'}</button></div></div></section></div>;
}
