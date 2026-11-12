import { useStore } from '../state/store';

/** Scrolling headline strip; pauses on hover. */
export function NewsTicker() {
  const news = useStore((s) => s.news);
  if (!news.length) return <footer className="ticker"><span className="ticker-label">News</span><span className="dim">No headlines yet.</span></footer>;

  const chars = news.reduce((n, a) => n + a.title.length + a.site.length + 6, 0);
  const items = news.map((a) => (
    <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="ticker-item">
      <b>{a.site}</b> {a.title}
    </a>
  ));
  return (
    <footer className="ticker">
      <span className="ticker-label">News</span>
      <div className="ticker-view">
        <div className="ticker-track" style={{ animationDuration: `${Math.max(40, chars * 0.16)}s` }}>
          <span className="ticker-run">{items}</span>
          <span className="ticker-run" aria-hidden="true">{items}</span>
        </div>
      </div>
    </footer>
  );
}
