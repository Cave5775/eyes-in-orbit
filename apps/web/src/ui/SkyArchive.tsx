import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveImagesResult } from '@eio/core';
import { api } from '../api/client';
import { cardBody, cardTitle, cardView, captionOf, createArchiveCache, stepIndex } from '../lib/archive-card';
import { useStore } from '../state/store';
import { useView } from '../state/view';

const cache = createArchiveCache((obs, body) => api.archiveImages(obs, body));

/**
 * Images of the selected body taken by the observatory the Sky view stands at, from that observatory's public archive
 * (server `GET /api/archive-images`; MAST for Hubble and JWST). A compact, collapsible card on the right of the sky view, opened by
 * selecting a planet, dwarf planet, the Moon or the Sun (a single click on its marker already selects it). Thumbnails are loaded
 * lazily straight from the archive (an `<img>` needs no CORS); a click on one opens it in a lightbox over the scene area. Esc
 * closes the lightbox first (a capture listener, so the app's own Esc, which leaves the sky view, does not also run).
 * Mounted in SceneView's `.scene`, beside the Sky overlay; renders nothing while the sky view is not on.
 */
export function SkyArchive() {
  const phase = useView((s) => s.sky.phase);
  const obsId = useView((s) => s.sky.obsId);
  const selectedId = useStore((s) => s.selectedId);
  const body = useStore((s) => (s.selectedId ? cardBody(s.entities.get(s.selectedId)) : null));
  const bodyName = useStore((s) => (s.selectedId ? s.entities.get(s.selectedId)?.name : undefined));
  const obsName = useStore((s) => (obsId ? s.entities.get(obsId)?.name : undefined));
  const active = (phase === 'entering' || phase === 'on') && !!obsId && !!body && !!selectedId;
  const [result, setResult] = useState<ArchiveImagesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [box, setBox] = useState(-1);
  const boxRef = useRef(-1);
  boxRef.current = box;

  const key = active ? `${obsId}|${body}` : '';
  useEffect(() => {
    setResult(null);
    setError(null);
    setBox(-1);
    if (!key) return;
    let cancelled = false;
    cache.get(obsId!, body!).then(
      (r) => { if (!cancelled) setResult(r); },
      (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const view = useMemo(() => cardView(obsName ?? 'This observatory', result, error), [obsName, result, error]);
  const images = view.kind === 'ok' ? view.images : [];

  // the lightbox: Esc closes it before anything else sees the key; arrows step
  useEffect(() => {
    if (box < 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        setBox(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.stopImmediatePropagation();
        e.preventDefault();
        setBox((i) => stepIndex(i, images.length, e.key === 'ArrowRight' ? 1 : -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [box < 0, images.length]);

  if (!active) return null;
  const shown = box >= 0 ? images[box] : undefined;
  return (
    <>
      <aside className="sky-archive" data-open={open} aria-label="Archive images" data-state={view.kind}>
        <div className="sky-archive-head">
          <span className="sky-archive-title" title={cardTitle(bodyName ?? body!, obsName ?? '')}>{cardTitle(bodyName ?? body!, obsName ?? '')}</span>
          <button className="key" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse the image card' : 'Expand the image card'} title={open ? 'Collapse' : 'Expand'}>{open ? '−' : '+'}</button>
        </div>
        {open && (
          <div className="sky-archive-body">
            <p className={`sky-archive-note ${view.kind}`} role={view.kind === 'error' ? 'alert' : 'status'}>{view.text}</p>
            {view.kind === 'ok' && (
              <ul className="sky-archive-grid">
                {view.images.map((img, i) => (
                  <li key={img.id}>
                    <button className="sky-archive-thumb" onClick={() => setBox(i)} title={captionOf(img)} aria-label={`Enlarge: ${captionOf(img)}`}>
                      <img src={img.thumbUrl} alt={captionOf(img)} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                    </button>
                    <span className="sky-archive-cap mono">{captionOf(img).split('  ·  ').slice(0, 3).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {result?.archive && (
              <a className="sky-archive-link" href={result.archive.url} target="_blank" rel="noreferrer noopener">{result.archive.label}</a>
            )}
          </div>
        )}
      </aside>
      {shown && (
        <div className="sky-lightbox" role="dialog" aria-modal="true" aria-label={captionOf(shown)} onClick={() => setBox(-1)}>
          <figure onClick={(e) => e.stopPropagation()}>
            <img src={shown.fullUrl} alt={captionOf(shown)} referrerPolicy="no-referrer" />
            <figcaption className="mono">
              <span>{captionOf(shown)}</span>
              <span>{shown.id}{shown.program ? `  ·  programme ${shown.program}` : ''}</span>
              <a href={shown.pageUrl} target="_blank" rel="noreferrer noopener">Open in the {result?.archive?.label ?? 'archive'} search</a>
            </figcaption>
          </figure>
          {images.length > 1 && (
            <>
              <button className="key sky-lightbox-prev" onClick={(e) => { e.stopPropagation(); setBox(stepIndex(box, images.length, -1)); }} aria-label="Previous image">&lsaquo;</button>
              <button className="key sky-lightbox-next" onClick={(e) => { e.stopPropagation(); setBox(stepIndex(box, images.length, 1)); }} aria-label="Next image">&rsaquo;</button>
            </>
          )}
          <button className="key sky-lightbox-close" onClick={(e) => { e.stopPropagation(); setBox(-1); }} aria-label="Close the image" title="Close (Esc)">&times;</button>
        </div>
      )}
    </>
  );
}
