import { Copy, Download, Eye, EyeOff, FolderInput, Info, Pencil, Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fileUrl } from '../../api/entries';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import type { Entry } from '../../types/entries';

export type EntryActionId = 'rename' | 'move' | 'properties' | 'delete' | 'publish' | 'hide';

export type EntryAction = {
  id: string;
  labelKey: MessageKey;
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
    ? { id: 'open', labelKey: 'action.open', icon: FolderInput, onSelect: () => handlers.onOpen(entry) }
    : { id: 'preview', labelKey: 'action.preview', icon: Eye, onSelect: () => handlers.onPreview(entry) }];
  if (entry.capabilities.download) actions.push(
    { id: 'download', labelKey: 'action.download', icon: Download, href: fileUrl(entry, true), onSelect: () => undefined },
    { id: 'copy', labelKey: 'action.copyLink', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(new URL(fileUrl(entry), window.location.origin).toString()).catch(() => undefined) },
  );
  if (entry.capabilities.rename) actions.push({ id: 'rename', labelKey: 'action.rename', icon: Pencil, onSelect: () => handlers.onAction('rename', entry) });
  if (entry.capabilities.move) actions.push({ id: 'move', labelKey: 'action.move', icon: FolderInput, onSelect: () => handlers.onAction('move', entry) });
  if (entry.capabilities.rename) actions.push({ id: 'properties', labelKey: 'action.properties', icon: Info, onSelect: () => handlers.onAction('properties', entry) });
  if (entry.capabilities.changeVisibility) actions.push({ id: entry.isPublic ? 'hide' : 'publish', labelKey: entry.isPublic ? 'action.hide' : 'action.publish', icon: entry.isPublic ? EyeOff : Eye, onSelect: () => handlers.onAction(entry.isPublic ? 'hide' : 'publish', entry) });
  if (entry.capabilities.delete) actions.push({ id: 'delete', labelKey: 'action.delete', icon: Trash2, destructive: true, onSelect: () => handlers.onAction('delete', entry) });
  return actions;
}

export function EntryActionMenu({ entry, anchor, actions, onClose }: {
  entry: Entry;
  anchor?: HTMLElement | null;
  actions: EntryAction[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useLayoutEffect(() => {
    if (!menu.current) return;
    const anchorRect = anchor?.getBoundingClientRect() ?? new DOMRect(window.innerWidth - 8, 8, 0, 0);
    const menuRect = menu.current.getBoundingClientRect();
    const edge = 8;
    const gap = 4;
    const maxLeft = Math.max(edge, window.innerWidth - menuRect.width - edge);
    const left = Math.min(Math.max(anchorRect.left, edge), maxLeft);
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - menuRect.height - gap;
    const top = Math.min(Math.max(below + menuRect.height <= window.innerHeight - edge ? below : above, edge), Math.max(edge, window.innerHeight - menuRect.height - edge));
    setPosition({ left, top });
  }, [anchor]);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const outside = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) onClose(); };
    window.addEventListener('keydown', close);
    window.addEventListener('mousedown', outside);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('mousedown', outside); restoreFocus.current?.focus(); };
  }, [onClose]);
  return <div className="actionMenu" ref={menu} role="menu" aria-label={t('entry.actions', { name: entry.name })} style={{ position: 'fixed', left: position.left, top: position.top, right: 'auto' }}>
    {actions.map((action) => {
      const Icon = action.icon;
      const content = <>{Icon ? <Icon aria-hidden={true} size={16} /> : null}{t(action.labelKey)}</>;
      if (action.href) return <a key={action.id} role="menuitem" href={action.href} onClick={onClose}>{content}</a>;
      return <button key={action.id} className={action.destructive ? 'destructive' : undefined} role="menuitem" type="button" onClick={() => { action.onSelect(); onClose(); }}>{content}</button>;
    })}
  </div>;
}
