import type { ComponentType } from 'react';
import { useEffect, useRef } from 'react';
import type { MessageKey } from '../../i18n/messages';

export type MobileAction = {
  id: string;
  label?: string;
  labelKey?: MessageKey;
  onSelect: () => void;
  href?: string;
  destructive?: boolean;
  icon?: ComponentType<{ 'aria-hidden'?: boolean; size?: number }>;
};

export function MobileActionSheet({ open, title, anchor, actions, translate, cancelLabel = 'Cancel', onClose }: {
  open: boolean;
  title: string;
  anchor?: HTMLElement | null;
  actions: MobileAction[];
  translate?: (key: MessageKey) => string;
  cancelLabel?: string;
  onClose: () => void;
}) {
  const firstAction = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    firstAction.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      previouslyFocused.current?.focus();
    };
  }, [anchor, onClose, open]);

  if (!open) return null;

  return (
    <div className="mobileActionBackdrop" onMouseDown={onClose}>
      <section className="mobileActionSheet" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mobileActionSheetHandle" aria-hidden="true" />
        <h2>{title}</h2>
        <div className="mobileActionList">
          {actions.map((action, index) => {
            const Icon = action.icon;
            const content = <>{Icon ? <Icon aria-hidden={true} size={18} /> : null}{action.labelKey ? translate?.(action.labelKey) ?? action.labelKey : action.label}</>;
            const className = `mobileAction${action.destructive ? ' destructive' : ''}`;
            const setFirstAction = index === 0 ? (node: HTMLButtonElement | HTMLAnchorElement | null) => { firstAction.current = node; } : undefined;
            if (action.href) return <a key={action.id} ref={setFirstAction} className={className} href={action.href} onClick={onClose}>{content}</a>;
            return <button key={action.id} ref={setFirstAction} className={className} type="button" onClick={() => { action.onSelect(); onClose(); }}>{content}</button>;
          })}
        </div>
        <button className="mobileActionCancel" type="button" onClick={onClose}>{cancelLabel}</button>
      </section>
    </div>
  );
}
