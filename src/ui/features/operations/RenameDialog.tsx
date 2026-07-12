import { X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';

export function RenameDialog({ open, title = 'Rename', initialName = '', submitLabel = 'Save', onClose, onSubmit }: {
  open: boolean; title?: string; initialName?: string; submitLabel?: string; onClose: () => void; onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setName(initialName); setError(null); requestAnimationFrame(() => input.current?.focus()); } }, [open, initialName]);
  if (!open) return null;
  async function submit(event: FormEvent) { event.preventDefault(); if (!name.trim()) { setError('Enter a name.'); return; } setBusy(true); setError(null); try { await onSubmit(name.trim()); onClose(); } catch (reason) { setError(reason instanceof ApiError && reason.code === 'ENTRY_NAME_CONFLICT' ? 'A file or folder with this name already exists.' : reason instanceof Error ? reason.message : 'Unable to save.'); } finally { setBusy(false); } }
  return <div className="dialogBackdrop" onMouseDown={onClose}><section className="operationDialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><div className="dialogHeader"><h2>{title}</h2><button className="iconButton" type="button" onClick={onClose} aria-label="Close"><X aria-hidden="true" size={17} /></button></div><form onSubmit={submit}><label>Name<input ref={input} value={name} onChange={(event) => setName(event.target.value)} /></label>{error ? <p className="formError" role="alert">{error}</p> : null}<div className="dialogButtons"><button className="button" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving' : submitLabel}</button></div></form></section></div>;
}
