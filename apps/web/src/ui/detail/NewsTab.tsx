import { useEffect, useState } from 'react';
import type { Article } from '@eio/core';
import { api } from '../../api/client';
import { fmtAgo } from '../../lib/format';
import { useStore } from '../../state/store';
import { useWallNow } from '../hooks';

export function ArticleList({ articles }: { articles: Article[] }) {
  const now = useWallNow(30_000);
  if (!articles.length) return <div className="empty">No articles.</div>;
  return (
    <ul className="news-list">
      {articles.map((a) => (
        <li key={a.id}>
          <a href={a.url} target="_blank" rel="noopener noreferrer">{a.title}</a>
          <div className="news-meta mono dim">{a.site} · {fmtAgo(Date.parse(a.publishedAt), now)}</div>
          {a.summary && <p className="news-sum">{a.summary}</p>}
        </li>
      ))}
    </ul>
  );
}

export function NewsTab({ entityId }: { entityId: string }) {
  const globalNews = useStore((s) => s.news);
  const [scope, setScope] = useState<'entity' | 'global'>('entity');
  const [entityNews, setEntityNews] = useState<Article[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stale = false;
    setEntityNews(null);
    setError(false);
    api.news({ entity: entityId, limit: 20 })
      .then((a) => !stale && setEntityNews(a))
      .catch(() => !stale && setError(true));
    return () => { stale = true; };
  }, [entityId]);

  return (
    <div>
      <div className="chips">
        <button className={scope === 'entity' ? 'chip on' : 'chip'} onClick={() => setScope('entity')}>This object</button>
        <button className={scope === 'global' ? 'chip on' : 'chip'} onClick={() => setScope('global')}>All spaceflight</button>
      </div>
      {scope === 'global' ? (
        <ArticleList articles={globalNews} />
      ) : error ? (
        <div className="empty">News search failed.</div>
      ) : entityNews === null ? (
        <div className="empty">Loading...</div>
      ) : (
        <ArticleList articles={entityNews} />
      )}
    </div>
  );
}
