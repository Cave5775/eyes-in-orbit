import { useCallback, useEffect, useRef, useState } from 'react';
import { useDismiss } from './hooks';
import { StreamUrlInput } from './StreamUrlInput';

/** Top bar "Watch" button: a small popover with the livestream URL field, so a stream can be opened without the Data streams popup. */
export function WatchMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, root, close);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div className="menu-anchor" ref={root}>
      <button
        ref={button} className={open ? 'key on' : 'key'} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-haspopup="true" title="Play a livestream from a link in a small floating window">
        Watch
      </button>
      {open && (
        <div className="popover watch-pop" role="group" aria-label="Watch a livestream">
          <StreamUrlInput compact onOpened={close} />
        </div>
      )}
    </div>
  );
}
