import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from 'react';
import { isEntryMutable, type Entry } from '../../types/entries';
import type { ExplorerView } from './ExplorerToolbar';
import { FileGrid } from './FileGrid';
import { FileList } from './FileList';
import type { EntryHandlers } from './EntryRow';

const MOBILE_QUERY = '(max-width: 760px)';
const BLOCKED_SHORTCUT_TARGETS = 'input, select, textarea, [role="menu"], [role="dialog"]';

interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ExplorerCollectionProps {
  view: ExplorerView;
  entries: Entry[];
  selectedIds: Set<string>;
  admin: boolean;
  handlers: EntryHandlers;
  onSelectAll(ids: string[]): void;
  onReplaceSelection(ids: string[]): void;
  onClearSelection(): void;
  fileUrlFor?: (entry: Entry, download: boolean) => string;
}

function intersects(first: MarqueeRect, second: DOMRect): boolean {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}

function marqueeStyle(rect: MarqueeRect): CSSProperties {
  return {
    position: 'fixed',
    zIndex: 10,
    pointerEvents: 'none',
    left: rect.left,
    top: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    border: '1px solid var(--accent)',
    background: 'var(--accent-soft)',
  };
}

export function ExplorerCollection({
  view,
  entries,
  selectedIds,
  admin,
  handlers,
  onSelectAll,
  onReplaceSelection,
  onClearSelection,
  fileUrlFor,
}: ExplorerCollectionProps) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const marqueeFrame = useRef<number | null>(null);
  const mutableIds = useMemo(() => admin ? entries.filter(isEntryMutable).map((entry) => entry.id) : [], [admin, entries]);

  const cancelMarquee = useCallback(() => {
    marqueeStart.current = null;
    if (marqueeFrame.current !== null) cancelAnimationFrame(marqueeFrame.current);
    marqueeFrame.current = null;
    setMarquee(null);
  }, []);

  function finishMarquee() {
    marqueeStart.current = null;
    setMarquee(null);
  }

  useEffect(() => {
    setFocusedId((current) => current && entries.some((entry) => entry.id === current) ? current : null);
    cancelMarquee();
  }, [cancelMarquee, entries]);

  useEffect(() => cancelMarquee, [cancelMarquee]);

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && target !== event.currentTarget && target.closest(BLOCKED_SHORTCUT_TARGETS)) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      onSelectAll(mutableIds);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      cancelMarquee();
      onClearSelection();
      return;
    }

    const focusedIndex = entries.findIndex((entry) => entry.id === focusedId);
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
      const nextIndex = focusedIndex < 0
        ? (backwards ? entries.length - 1 : 0)
        : Math.max(0, Math.min(entries.length - 1, focusedIndex + (backwards ? -1 : 1)));
      setFocusedId(entries[nextIndex]?.id ?? null);
      return;
    }

    const focusedEntry = focusedIndex >= 0 ? entries[focusedIndex] : null;
    if (!focusedEntry) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (focusedEntry.kind === 'folder') handlers.onOpen(focusedEntry);
      else handlers.onPreview(focusedEntry);
    }
    if ((event.key === ' ' || event.key === 'Spacebar') && admin && isEntryMutable(focusedEntry)) {
      event.preventDefault();
      handlers.onToggle(focusedEntry, { range: event.shiftKey });
    }
  }

  function onPointerDown(event: PointerEvent<HTMLUListElement>) {
    if (!admin || !mutableIds.length || window.matchMedia(MOBILE_QUERY).matches) return;
    if (event.button !== 0 || event.isPrimary === false || event.target !== event.currentTarget) return;
    marqueeStart.current = { x: event.clientX, y: event.clientY };
    setMarquee({ left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent<HTMLUListElement>) {
    const start = marqueeStart.current;
    if (!start) return;
    const collection = event.currentTarget;
    const rect = {
      left: Math.min(start.x, event.clientX),
      top: Math.min(start.y, event.clientY),
      right: Math.max(start.x, event.clientX),
      bottom: Math.max(start.y, event.clientY),
    };
    setMarquee(rect);
    if (marqueeFrame.current !== null) cancelAnimationFrame(marqueeFrame.current);
    marqueeFrame.current = requestAnimationFrame(() => {
      marqueeFrame.current = null;
      const hits = [...collection.querySelectorAll<HTMLElement>('[data-entry-id]')]
        .filter((element) => intersects(rect, element.getBoundingClientRect()))
        .map((element) => element.dataset.entryId!)
        .filter((id) => mutableIds.includes(id));
      onReplaceSelection(hits);
    });
  }

  const interactionProps: HTMLAttributes<HTMLUListElement> = {
    tabIndex: 0,
    'aria-activedescendant': focusedId ? `explorer-entry-${focusedId}` : undefined,
    onKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp: finishMarquee,
    onPointerCancel: cancelMarquee,
  };

  return (
    <>
      {view === 'list'
        ? <FileList entries={entries} selectedIds={selectedIds} admin={admin} handlers={handlers} interactionProps={interactionProps} focusedId={focusedId} fileUrlFor={fileUrlFor} />
        : <FileGrid entries={entries} selectedIds={selectedIds} admin={admin} handlers={handlers} interactionProps={interactionProps} focusedId={focusedId} />}
      {marquee ? <div className="selectionMarquee" aria-hidden="true" style={marqueeStyle(marquee)} /> : null}
    </>
  );
}
