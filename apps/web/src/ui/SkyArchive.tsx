import { useEffect, useMemo, useState } from 'react';
import type { ArchiveImagesResult } from '@eio/core';
import { api } from '../api/client';
import { MORE_STEP, THUMBS_FIRST, cardBody, cardTitle, cardView, captionOf, createArchiveCache, stepIndex } from '../lib/archive-card';
import { useStore } from '../state/store';
import { useView } from '../state/view';

const cache = createArchiveCache((obs, body) => api.archiveImages(obs, body));

/**
 * Images of the selected body taken by the observatory the Sky view stands at, from that observatory's public archive
 * (`api.archiveImages`; MAST for Hubble and JWST). A compact, collapsible card on the right of the sky view, opened by
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
  const key = active ? `${obsId}|${body}` : '';
  // every piece of state carries the key it belongs to: for the render after a selection change the old body's answer, lightbox and count are ignored
  const [res, setRes] = useState<{ key: string; result: ArchiveImagesResult | null; error: string | null }>({ key: '', result: null, error: null });
  const [open, setOpen] = useState(true);
  const [boxS, setBoxS] = useState({ key: '', i: -1 });
  const [moreS, setMoreS] = useState({ key: '', n: THUMBS_FIRST });
  const result = res.key === key ? res.result : null;
  const error = res.key === key ? res.error : null;
  const box = boxS.key === key ? boxS.i : -1;
  const shownCount = moreS.key === key ? moreS.n : THUMBS_FIRST;
  const setBox = (u: number | ((i: number) => number)): void => setBoxS((b) => ({ key, i: typeof u === 'function' ? u(b.key === key ? b.i : -1) : u }));
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    cache.get(obsId!, body!).then(
      (r) => { if (!cancelled) setRes({ key, result: r, error: null }); },
      (e: unknown) => { if (!cancelled) setRes({ key, result: null, error: e instanceof Error ? e.message : String(e) }); },
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
                {view.images.slice(0, shownCount).map((img, i) => (
                  <li key={img.id}>
                    <button className="sky-archive-thumb" onClick={() => setBox(i)} title={captionOf(img)} aria-label={`Enlarge: ${captionOf(img)}`}>
                      <img src={img.thumbUrl} alt={captionOf(img)} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                    </button>
                    <span className="sky-archive-cap mono">{captionOf(img).split('  ·  ').slice(0, 3).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {view.kind === 'ok' && view.images.length > shownCount && (
              <button className="key sky-archive-more" onClick={() => setMoreS({ key, n: shownCount + MORE_STEP })}>Show more ({view.images.length - shownCount} left)</button>
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
