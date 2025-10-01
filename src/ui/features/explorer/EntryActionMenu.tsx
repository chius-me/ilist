import { Copy, Download, Eye, EyeOff, FolderInput, Info, Pencil, Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';
import { useEffect, useRef } from 'react';
import { fileUrl } from '../../api/entries';
import type { Entry } from '../../types/entries';

export type EntryActionId = 'rename' | 'move' | 'properties' | 'delete' | 'publish' | 'hide';

export type EntryAction = {
  id: string;
  label: string;
  onSelect: () => void;
  href?: string;
  destructive?: boolean;
  icon?: ComponentType<{ 'aria-hidden'?: boolean; size?: number }>;
};

export function entryActions(entry: Entry, handlers: {
  onOpen: (entry: Entry) => void;
  onPreview: (entry: Entry) => void;
  onAction: (action: EntryActionId, entry: Entry) => void;
}): EntryAction[] {
  const actions: EntryAction[] = [entry.kind === 'folder'
    ? { id: 'open', label: 'Open', icon: FolderInput, onSelect: () => handlers.onOpen(entry) }
    : { id: 'preview', label: 'Preview', icon: Eye, onSelect: () => handlers.onPreview(entry) }];
  if (entry.capabilities.download) actions.push(
    { id: 'download', label: 'Download', icon: Download, href: fileUrl(entry, true), onSelect: () => undefined },
    { id: 'copy', label: 'Copy link', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(new URL(fileUrl(entry), window.location.origin).toString()).catch(() => undefined) },
  );
  if (entry.capabilities.rename) actions.push({ id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => handlers.onAction('rename', entry) });
  if (entry.capabilities.move) actions.push({ id: 'move', label: 'Move', icon: FolderInput, onSelect: () => handlers.onAction('move', entry) });
  if (entry.capabilities.rename) actions.push({ id: 'properties', label: 'Properties', icon: Info, onSelect: () => handlers.onAction('properties', entry) });
  if (entry.capabilities.changeVisibility) actions.push({ id: entry.isPublic ? 'hide' : 'publish', label: entry.isPublic ? 'Hide' : 'Publish', icon: entry.isPublic ? EyeOff : Eye, onSelect: () => handlers.onAction(entry.isPublic ? 'hide' : 'publish', entry) });
  if (entry.capabilities.delete) actions.push({ id: 'delete', label: 'Delete', icon: Trash2, destructive: true, onSelect: () => handlers.onAction('delete', entry) });
  return actions;
}

export function EntryActionMenu({ entry, actions, onClose }: {
  entry: Entry;
  actions: EntryAction[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const outside = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', close);
    window.addEventListener('mousedown', outside);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('mousedown', outside); previouslyFocused.current?.focus(); };
  }, [onClose]);
  return <div className="actionMenu" ref={menu} role="menu" aria-label={`Actions for ${entry.name}`}>
    {actions.map((action) => {
      const Icon = action.icon;
      const content = <>{Icon ? <Icon aria-hidden={true} size={16} /> : null}{action.label}</>;
      if (action.href) return <a key={action.id} role="menuitem" href={action.href} onClick={onClose}>{content}</a>;
      return <button key={action.id} className={action.destructive ? 'destructive' : undefined} role="menuitem" type="button" onClick={() => { action.onSelect(); onClose(); }}>{content}</button>;
    })}
  </div>;
}
