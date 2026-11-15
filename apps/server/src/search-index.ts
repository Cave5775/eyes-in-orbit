import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { rankMatches, type EntityRecord } from '@eio/core';

// loaded via require: Vite/Vitest cannot resolve the prefix-only builtin `node:sqlite` as an ES import
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Full-text index of the entity catalogue: an FTS5 table with the `trigram` tokenizer, which finds any substring of three or
 * more characters (what the client's text search means: a substring of the id, the name or an alias). It replaces ranking the
 * whole catalogue in the browser (docs/perf.md: 83 ms for one query at 100 k, 1 s at 1 M) with one index lookup plus ranking of
 * the candidates only.
 *
 * Kept in its own in-memory database, not in `cache.sqlite`: the catalogue it indexes is itself rebuilt in memory by the
 * connectors at every start, so a persisted index would only have to be rebuilt or checked against it. It follows the hub:
 * `sync(ids)` after each `entities.changed`. Rows are lower-cased text (`case_sensitive 1` below is then exact), one row per
 * entity: id, name and alias values, one per line (a line break cannot be typed into a query, so a match never spans fields).
 *
 * Two plain columns (`kind`, `body`, `grp`) sit in a side table of the same rowids so counts per body and kind are one
 * `GROUP BY`, not a pass over the catalogue.
 */

/** Most candidates one query takes from the index (a three-letter query on a huge catalogue could match nearly everything). */
export const MAX_CANDIDATES = 300_000;
/** Most ids one answer carries. */
export const MAX_MATCH = 100_000;
/** Shortest query the trigram index can answer; shorter ones scan the catalogue. */
export const MIN_INDEXED = 3;

export interface MatchResult {
  /** every matching entity id, best first (capped at `MAX_MATCH`) */
  ids: string[];
  /** matches found (more than `ids.length` when `truncated`) */
  total: number;
  /** the answer is incomplete: more matches exist than were returned or ranked */
  truncated: boolean;
  /** how it was answered: the trigram index or a scan of the catalogue (a query under three characters) */
  via: 'index' | 'scan';
}

export interface CountRow {
  body: string;
  kind: string;
  group: string | null;
  count: number;
}

const textOf = (rec: EntityRecord): string => [rec.id, rec.name, ...Object.values(rec.aliases).map(String)].join('\n').toLowerCase();

/** The FTS phrase for a literal substring: the query in double quotes, quotes doubled. Control characters become spaces. */
export const ftsPhrase = (q: string): string => `"${q.replace(/[\u0000-\u001f]/g, ' ').replace(/"/g, '""')}"`;

export class SearchIndex {
  private db: Database;
  private rowOf = new Map<string, number>();
  private nextRow = 1;
  private lookup: (id: string) => EntityRecord | undefined;

  /** `lookup` reads the current record of an id (the hub's graph). */
  constructor(lookup: (id: string) => EntityRecord | undefined) {
    this.lookup = lookup;
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE VIRTUAL TABLE fts USING fts5(text, tokenize = 'trigram case_sensitive 1');
      CREATE TABLE ent (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, grp TEXT);
      CREATE INDEX ent_count ON ent (body, kind, grp);
    `);
  }

  get size(): number {
    return this.rowOf.size;
  }

  /** Add or replace records (one transaction). */
  upsert(recs: Iterable<EntityRecord>): void {
    const del = this.db.prepare('DELETE FROM fts WHERE rowid = ?');
    const ins = this.db.prepare('INSERT INTO fts (rowid, text) VALUES (?, ?)');
    const add = this.db.prepare('INSERT INTO ent (rowid, id, kind, body, grp) VALUES (?, ?, ?, ?, ?)');
    const put = this.db.prepare('UPDATE ent SET id = ?2, kind = ?3, body = ?4, grp = ?5 WHERE rowid = ?1');
    this.db.exec('BEGIN');
    try {
      for (const rec of recs) {
        let row = this.rowOf.get(rec.id);
        const fresh = row === undefined;
        if (row === undefined) {
          row = this.nextRow++;
          this.rowOf.set(rec.id, row);
        } else del.run(row);
        ins.run(row, textOf(rec));
        (fresh ? add : put).run(row, rec.id, rec.kind, rec.bodyId, rec.group ?? null);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  remove(ids: Iterable<string>): void {
    const del = this.db.prepare('DELETE FROM fts WHERE rowid = ?');
    const delEnt = this.db.prepare('DELETE FROM ent WHERE rowid = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        const row = this.rowOf.get(id);
        if (row === undefined) continue;
        del.run(row);
        delEnt.run(row);
        this.rowOf.delete(id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Bring the index in line with the hub for the ids that changed: present ones are (re)indexed, gone ones dropped. */
  sync(ids: Iterable<string>): void {
    const present: EntityRecord[] = [];
    const gone: string[] = [];
    for (const id of ids) {
      const rec = this.lookup(id);
      if (rec) present.push(rec);
      else gone.push(id);
    }
    if (gone.length) this.remove(gone);
    if (present.length) this.upsert(present);
  }

  /** Index the whole catalogue (start-up, or a test). */
  rebuild(recs: Iterable<EntityRecord>): void {
    this.db.exec('DELETE FROM fts; DELETE FROM ent;');
    this.rowOf.clear();
    this.nextRow = 1;
    this.upsert(recs);
  }

  /**
   * Every entity matching `q`, best first, by the shared ranking (`matchScore`): the index supplies the candidates (a superset:
   * a substring of the lower-cased id, name or alias), the ranking drops the false ones and orders the rest. A query under
   * three characters cannot use the index and scans `all` instead. Same answer as ranking the whole catalogue.
   */
  match(q: string, all: () => Iterable<EntityRecord>): MatchResult {
    const query = q.trim().toLowerCase();
    if (!query) return { ids: [], total: 0, truncated: false, via: 'scan' };
    let candidates: Iterable<EntityRecord>;
    let truncated = false;
    let via: MatchResult['via'] = 'index';
    if ([...query].length < MIN_INDEXED) {
      candidates = all();
      via = 'scan';
    } else {
      const rows = this.db
        .prepare('SELECT ent.id AS id FROM fts JOIN ent ON ent.rowid = fts.rowid WHERE fts MATCH ? LIMIT ?')
        .all(ftsPhrase(query), MAX_CANDIDATES + 1) as { id: string }[];
      if (rows.length > MAX_CANDIDATES) {
        rows.length = MAX_CANDIDATES;
        truncated = true;
      }
      const recs: EntityRecord[] = [];
      for (const r of rows) {
        const rec = this.lookup(r.id);
        if (rec) recs.push(rec);
      }
      candidates = recs;
    }
    const ranked = rankMatches(candidates, query);
    const total = ranked.length;
    const ids = ranked.slice(0, MAX_MATCH).map((r) => r.rec.id);
    return { ids, total, truncated: truncated || total > MAX_MATCH, via };
  }

  /** Entity counts per body, kind and group (one `GROUP BY` over the index's side table). */
  counts(): CountRow[] {
    return this.db
      .prepare('SELECT body, kind, grp AS "group", COUNT(*) AS count FROM ent GROUP BY body, kind, grp ORDER BY count DESC, body, kind, grp')
      .all() as unknown as CountRow[];
  }

  close(): void {
    this.db.close();
  }
}
