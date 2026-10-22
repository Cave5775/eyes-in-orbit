import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { dragSize, keyboardStep } from '../lib/layout';

interface Props {
  /** `vertical`: the divider is a vertical line and the drag changes a width. `horizontal`: a height. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  /** current effective size, px */
  value: number;
  min: number;
  max: number;
  /** +1 when moving right/down grows the panel, -1 when moving right/down shrinks it */
  grow: 1 | -1;
  /** receives the requested size (unclamped; the owner clamps) */
  onChange(px: number): void;
  onReset(): void;
  className?: string;
}

/**
 * Draggable, keyboard-operable divider. The drag uses pointer capture, so move events keep arriving
 * over the WebGL canvas and iframes; while it lasts `body.resizing` also disables pointer events on both.
 */
export function Splitter({ orientation, label, value, min, max, grow, onChange, onReset, className = '' }: Props) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const [active, setActive] = useState(false);
  const vertical = orientation === 'vertical';

  useEffect(() => {
    if (!active) return;
    const cls = vertical ? 'resizing-x' : 'resizing-y';
    document.body.classList.add('resizing', cls);
    return () => document.body.classList.remove('resizing', cls);
  }, [active, vertical]);

  const pos = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: pos(e), size: value };
    setActive(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s) onChange(dragSize(s.size, pos(e) - s.pos, grow));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = keyboardStep(e.shiftKey);
    // arrow keys move the divider in the arrow's direction
    const dir = vertical ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (dir !== undefined) onChange(value + dir * grow * step);
    else if (e.key === 'Home') onChange(min);
    else if (e.key === 'End') onChange(max);
    else if (e.key === 'Enter') onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (drag, arrow keys, double-click to reset)`}
      className={`splitter ${vertical ? 'sp-v' : 'sp-h'} ${active ? 'active' : ''} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
