import { useState, type FormEvent } from 'react';
import { MAX_FLOATS } from '../lib/floating';
import { canOpenStream } from '../lib/sky-window';
import { watchResult } from '../lib/stream-url';
import { pageOrigin } from '../lib/youtube';
import { useStore } from '../state/store';

/**
 * "Watch a livestream": paste a link, press Enter, and it plays in a pop-out window (ui/FloatingLayer.tsx). Works again
 * and again for several streams at once, up to MAX_FLOATS. A link that is not supported shows the reason and, when it is
 * a web page at all, an "Open in new tab" link instead.
 */
export function StreamUrlInput({ compact = false, onOpened }: { compact?: boolean; onOpened?: () => void }) {
  const floats = useStore((s) => s.floats);
  const sky = useStore((s) => s.sky);
  const openFloat = useStore((s) => s.openFloat);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<{ error: string; href: string | null } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = watchResult(text, pageOrigin());
    if (!r.ok) {
      setProblem({ error: r.error, href: r.href });
      return;
    }
    const { embedUrl, title } = r.embed;
    if ((!canOpenStream(floats, sky) && !floats.some((f) => f.url === embedUrl)) || !openFloat(embedUrl, title)) {
      setProblem({ error: `At most ${MAX_FLOATS} floating windows (the Sky view counts): close one first.`, href: null });
      return;
    }
    setProblem(null);
    setText('');
    onOpened?.();
  };

  return (
    <form className={compact ? 'watch watch-compact' : 'watch'} onSubmit={submit}>
      <label className="watch-label" htmlFor={compact ? 'watch-url-compact' : 'watch-url'}>Watch a livestream</label>
      <div className="watch-row">
        <input
          id={compact ? 'watch-url-compact' : 'watch-url'} className="watch-input" type="text" inputMode="url" autoComplete="off" spellCheck={false}
          placeholder="Paste a YouTube, Twitch or Vimeo link" value={text} aria-invalid={problem ? true : undefined}
          onChange={(e) => { setText(e.target.value); if (problem) setProblem(null); }} />
        <button className="btn active" type="submit" title="Open this stream in a floating window">Watch</button>
      </div>
      {problem && (
        <div className="watch-error" role="alert">
          {problem.error}
          {problem.href && <> <a href={problem.href} target="_blank" rel="noopener noreferrer">Open in new tab</a></>}
        </div>
      )}
    </form>
  );
}
