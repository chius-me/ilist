import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus({
  active = true,
  containerRef,
  initialFocusRef,
  onClose,
  restoreFocus,
}: {
  active?: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  restoreFocus?: HTMLElement | null;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;
    const previous = restoreFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const isolated: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
    container.dataset.modalActive = 'true';

    let branch: HTMLElement = container;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        isolated.push({ element: sibling, inert: sibling.hasAttribute('inert'), ariaHidden: sibling.getAttribute('aria-hidden') });
        sibling.setAttribute('inert', '');
        sibling.setAttribute('aria-hidden', 'true');
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }

    (initialFocusRef.current ?? container.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      delete container.dataset.modalActive;
      for (const item of isolated) {
        if (!item.inert) item.element.removeAttribute('inert');
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
        else item.element.setAttribute('aria-hidden', item.ariaHidden);
      }
      previous?.focus();
    };
  }, [active, containerRef, initialFocusRef, restoreFocus]);
}
