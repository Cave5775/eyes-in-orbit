import { useEffect, useState } from 'react';
import { clock } from '../state/runtime';

/** Simulation time (ms), refreshed on an interval; independent of scene frames. */
export function useSimNow(intervalMs: number): number {
  const [t, setT] = useState(() => clock.now());
  useEffect(() => {
    const id = setInterval(() => setT(clock.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

export function useWallNow(intervalMs: number): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}
