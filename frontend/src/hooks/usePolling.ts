import { useEffect, useRef } from 'react';

/**
 * Calls `fn` immediately, then every `intervalMs` while the owning component
 * is mounted. Plain setInterval + cleanup -- no data-fetching library needed
 * at this scale (single board view, ~5s refresh).
 */
export function usePolling(fn: () => void, intervalMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    fnRef.current();
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
