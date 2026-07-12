import { Copy, Download, Eye, EyeOff, FolderInput, Info, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { fileUrl } from '../../api/entries';
import type { Entry } from '../../types/entries';

export type EntryAction = 'rename' | 'move' | 'properties' | 'delete' | 'publish' | 'hide';

export function EntryActionMenu({ entry, onOpen, onPreview, onAction, onClose }: {
  entry: Entry;
  onOpen: (entry: Entry) => void;
  onPreview: (entry: Entry) => void;
  onAction: (action: EntryAction, entry: Entry) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const outside = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', close);
    window.addEventListener('mousedown', outside);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('mousedown', outside); };
  }, [onClose]);
  const select = (action: EntryAction) => { onAction(action, entry); onClose(); };
  const copy = async () => {
    try { await navigator.clipboard?.writeText(new URL(fileUrl(entry), window.location.origin).toString()); } catch { /* Copy availability is browser controlled. */ }
    onClose();
  };
  return <div className="actionMenu" ref={menu} role="menu" aria-label={`Actions for ${entry.name}`}>
    {entry.kind === 'folder' ? <button role="menuitem" type="button" onClick={() => { onOpen(entry); onClose(); }}>Open</button> : <button role="menuitem" type="button" onClick={() => { onPreview(entry); onClose(); }}>Preview</button>}
    {entry.capabilities.download ? <a role="menuitem" href={fileUrl(entry, true)}><Download aria-hidden="true" size={16} />Download</a> : null}
    {entry.capabilities.download ? <button role="menuitem" type="button" onClick={copy}><Copy aria-hidden="true" size={16} />Copy link</button> : null}
    {entry.capabilities.rename ? <button role="menuitem" type="button" onClick={() => select('rename')}><Pencil aria-hidden="true" size={16} />Rename</button> : null}
    {entry.capabilities.move ? <button role="menuitem" type="button" onClick={() => select('move')}><FolderInput aria-hidden="true" size={16} />Move</button> : null}
    {entry.capabilities.rename ? <button role="menuitem" type="button" onClick={() => select('properties')}><Info aria-hidden="true" size={16} />Properties</button> : null}
    {entry.capabilities.changeVisibility ? <button role="menuitem" type="button" onClick={() => select(entry.isPublic ? 'hide' : 'publish')}>{entry.isPublic ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}{entry.isPublic ? 'Hide' : 'Publish'}</button> : null}
    {entry.capabilities.delete ? <button className="destructive" role="menuitem" type="button" onClick={() => select('delete')}><Trash2 aria-hidden="true" size={16} />Delete</button> : null}
  </div>;
}
