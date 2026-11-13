import { isTrustedDescribeUrl, type Description, type EntityRecord } from '@eio/core';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { fmtAgo } from '../../lib/format';
import { useWallNow } from '../hooks';

/** The text-description part of the About tab, split out so it can be rendered from a fixed `Description`. */
export function AboutBody({ d, now }: { d: Description; now: number }) {
  const links: [string, string][] = [];
  // defence in depth: the server already filters, but only trusted hosts are ever rendered as a link or image
  if (d.summary && isTrustedDescribeUrl(d.summary.url)) links.push(['Wikipedia', d.summary.url]);
  if (d.wikidata && isTrustedDescribeUrl(d.wikidata.url)) links.push(['Wikidata', d.wikidata.url]);
  if (d.discos?.url && isTrustedDescribeUrl(d.discos.url)) links.push(['ESA DISCOS', d.discos.url]);
  const nothing = !d.summary && !d.discos;
  return (
    <div className="about">
      {d.summary && (
        <div className="about-sum">
          {d.summary.thumbnail && isTrustedDescribeUrl(d.summary.thumbnail.url) && (
            <img
              className="about-thumb" src={d.summary.thumbnail.url} alt="" loading="lazy" referrerPolicy="no-referrer"
              width={Math.min(d.summary.thumbnail.width, 96)} />
          )}
          <div>
            <div className="about-title">{d.summary.title}</div>
            {d.summary.blurb && <div className="dim about-blurb">{d.summary.blurb}</div>}
          </div>
        </div>
      )}
      {d.summary && <p className="about-text">{d.summary.text}</p>}
      {d.discos && d.discos.facts.length > 0 && (
        <dl className="kv about-facts">
          {d.discos.facts.map((f) => (
            <div key={f.label} className="about-fact"><dt>{f.label}</dt><dd>{f.value}</dd></div>
          ))}
        </dl>
      )}
      {nothing && (
        <p className="about-text">
          No article found for this object. <a href={isTrustedDescribeUrl(d.searchUrl) ? d.searchUrl : 'https://en.wikipedia.org/'} target="_blank" rel="noopener noreferrer">Search Wikipedia</a>
        </p>
      )}
      <p className="about-fallback dim">{d.fallback}</p>
      {links.length > 0 && (
        <div className="about-links">
          {links.map(([label, href]) => <a key={label} href={href} target="_blank" rel="noopener noreferrer">{label}</a>)}
        </div>
      )}
      <div className="mono dim about-meta">
        {Object.values(d.sources).includes('error') && <span>some sources failed, retrying later · </span>}
        {d.sources.discos === 'off' && d.norad !== undefined && <span>ESA DISCOS facts need a token (Data streams, ESA DISCOS) · </span>}
        {d.fromCache ? 'cached' : 'fetched'} {fmtAgo(d.fetchedAt, now)}
      </div>
    </div>
  );
}

/** About: a description of the selected object, looked up by the server only now (Wikipedia via Wikidata, ESA DISCOS with a token). */
export function AboutTab({ rec }: { rec: EntityRecord }) {
  const [d, setD] = useState<Description | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useWallNow(30_000);

  useEffect(() => {
    let stale = false;
    setD(null);
    setError(null);
    api.describe(rec.id).then((x) => !stale && setD(x)).catch((e: Error) => !stale && setError(e.message));
    return () => { stale = true; };
  }, [rec.id]);

  if (error) return <div className="empty">Description unavailable: {error}</div>;
  if (!d) return <div className="empty">Looking up a description&hellip;</div>;
  return <AboutBody d={d} now={now} />;
}
