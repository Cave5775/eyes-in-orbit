import { useEffect, useState, type RefObject } from 'react';
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

/**
 * Close a popup on an outside click and on Esc (ViewMenu pattern): `root` is the element that counts as inside, `onClose`
 * runs for either. Esc is handled in the capture phase and stopped, so the app-wide Esc (back to the Earth view) does not also fire.
 */
export function useDismiss(open: boolean, root: RefObject<HTMLElement>, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node | null)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, root, onClose]);
}
