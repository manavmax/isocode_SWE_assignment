import { useEffect, useState } from 'react';

/**
 * The current device time as React state, refreshed by a wall-clock timer.
 * Components must not call Date.now() during render (purity rule): this hook
 * subscribes to the clock instead, so every read is stable between renders.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const iv = setInterval(tick, intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);

  return now;
}
