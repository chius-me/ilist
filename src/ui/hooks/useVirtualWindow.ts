import { useEffect, useState, type RefObject } from 'react';

export interface VirtualWindowOptions {
  count: number;
  itemHeight: number;
  containerRef?: RefObject<HTMLElement | null>;
  overscan?: number;
  threshold?: number;
}

export interface VirtualWindowRange {
  virtualized: boolean;
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
}

export function computeVirtualWindow(params: {
  count: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
  threshold?: number;
}): VirtualWindowRange {
  const { count, itemHeight, scrollTop, viewportHeight, overscan = 6, threshold = 100 } = params;
  if (count <= threshold || itemHeight <= 0) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: count,
      paddingTop: 0,
      paddingBottom: 0,
    };
  }

  const effectiveHeight = viewportHeight > 0 ? viewportHeight : 640;
  const visibleStart = Math.max(0, Math.floor(scrollTop / itemHeight));
  const visibleCount = Math.max(1, Math.ceil(effectiveHeight / itemHeight));
  const startIndex = Math.max(0, visibleStart - overscan);
  const endIndex = Math.min(count, visibleStart + visibleCount + overscan);

  return {
    virtualized: true,
    startIndex,
    endIndex,
    paddingTop: startIndex * itemHeight,
    paddingBottom: Math.max(0, (count - endIndex) * itemHeight),
  };
}

export function useVirtualWindow({
  count,
  itemHeight,
  containerRef,
  overscan = 6,
  threshold = 100,
}: VirtualWindowOptions): VirtualWindowRange {
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 640 });

  useEffect(() => {
    if (count <= threshold) return;
    const container = containerRef?.current;
    const measure = () => {
      if (container) {
        setMetrics({
          scrollTop: container.scrollTop,
          viewportHeight: container.clientHeight || window.innerHeight || 640,
        });
      } else {
        setMetrics({
          scrollTop: window.scrollY || 0,
          viewportHeight: window.innerHeight || 640,
        });
      }
    };
    measure();

    const target: EventTarget = container ?? window;
    target.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
    return () => {
      target.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [containerRef, count, threshold]);

  return computeVirtualWindow({
    count,
    itemHeight,
    scrollTop: metrics.scrollTop,
    viewportHeight: metrics.viewportHeight,
    overscan,
    threshold,
  });
}
