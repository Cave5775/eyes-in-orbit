import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord, type Launch } from '@eio/core';
import { EARTH_CENTRE } from '../src/lib/frame';
import { parseFrame, serialiseFrame } from '../src/lib/frame-store';
import { armFrameRestore, frameInfoOf, useStore } from '../src/state/store';

const rec = (id: string, bodyId = 'EARTH', extra: Partial<EntityRecord> = {}): EntityRecord => ({ id, name: id.toUpperCase(), kind: 'satellite', bodyId, aliases: {}, updatedAt: 0, ...extra });
const asteroid = rec('ceres', 'SUN', { kind: 'asteroid', attrs: { orbitable: true } });
const catalog = (): EntityRecord[] => [...bodyEntityRecords(), rec('iss'), rec('sat-b'), rec('lro', 'MOON'), asteroid];

const HOME = { selectedId: null, follow: false, frame: EARTH_CENTRE, frameLocked: false, focus: null };
const st = () => useStore.getState();
/** the part of the state the focus is made of */
const focusState = () => {
  const { selectedId, frame, frameLocked, follow } = st();
  return { selectedId, frame, frameLocked, follow };
};

describe('the focus in the store: selectedId, frame, lock, follow', () => {
  beforeEach(() => {
    useStore.setState({ ...HOME, entities: new Map() });
    st().upsertEntities(catalog(), true);
    useStore.setState({ ...HOME }); // a full load may have restored a frame
  });

  it('starts at the Earth, unlocked, nothing selected, not following', () => {
    expect(focusState()).toEqual({ selectedId: null, frame: 'body-earth', frameLocked: false, follow: false });
    expect(st().frame).toBe(EARTH_CENTRE);
  });

  describe('selectObject', () => {
    it('every body gives the same result from any starting state: selected, framed on, following, ONE focus request', () => {
      const starts = [
        HOME,
        { ...HOME, selectedId: 'iss', follow: true },
        { ...HOME, frame: 'body-mars', selectedId: 'body-mars', follow: true },
        { ...HOME, frame: 'lro' },
      ];
      for (const id of ['body-sun', 'body-earth', 'body-moon', 'body-mars']) {
        for (const start of starts) {
          useStore.setState({ ...start, focus: null });
          const nonce0 = st().focus?.nonce ?? 0;
          st().selectObject(id);
          expect(focusState()).toEqual({ selectedId: id, frame: id, frameLocked: false, follow: true });
          expect(st().focus).toEqual({ id, nonce: expect.any(Number) });
          expect(st().focus!.nonce).toBeGreaterThan(nonce0);
        }
      }
    });

    it('emits exactly one request per call, none for the other fields (a request is the only camera trigger)', () => {
      const seen: unknown[] = [];
      const off = useStore.subscribe((s, p) => { if (s.focus !== p.focus) seen.push(s.focus); });
      st().selectObject('body-moon');
      st().selectObject('iss');
      st().selectObject(null);
      st().setFrame('body-mars', true);
      st().setFrameLocked(false);
      st().setFollow(true);
      off();
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ id: 'body-moon' });
      expect(seen[1]).toMatchObject({ id: 'iss' });
    });

    it('selecting the same object again flies there again (a new request)', () => {
      st().selectObject('body-moon');
      const first = st().focus!.nonce;
      st().selectObject('body-moon');
      expect(st().focus!.nonce).toBeGreaterThan(first);
    });

    it('a plain object is selected and followed but never touches the frame (also while the frame is the Moon)', () => {
      st().selectObject('iss');
      expect(focusState()).toEqual({ selectedId: 'iss', frame: 'body-earth', frameLocked: false, follow: true });
      st().selectObject('body-moon');
      st().selectObject('iss');
      expect(focusState()).toEqual({ selectedId: 'iss', frame: 'body-moon', frameLocked: false, follow: true });
      st().selectObject('lro');
      expect(st().frame).toBe('body-moon');
      expect(st().focus).toMatchObject({ id: 'lro' });
    });

    it('an entity flagged attrs.orbitable becomes the frame like a body, an unflagged one does not', () => {
      st().selectObject('ceres');
      expect(focusState()).toEqual({ selectedId: 'ceres', frame: 'ceres', frameLocked: false, follow: true });
      st().selectObject('iss');
      expect(st().frame).toBe('ceres');
      useStore.setState({ ...HOME });
      st().upsertEntities([{ ...asteroid, attrs: { orbitable: false } }]);
      st().selectObject('ceres');
      expect(st().frame).toBe(EARTH_CENTRE);
    });

    it('a locked frame stays; the selection, follow and the focus request still go to the selected object', () => {
      st().selectObject('body-moon');
      st().setFrameLocked(true);
      const nonce = st().focus!.nonce;
      st().selectObject('body-mars');
      expect(focusState()).toEqual({ selectedId: 'body-mars', frame: 'body-moon', frameLocked: true, follow: true });
      expect(st().focus).toEqual({ id: 'body-mars', nonce: expect.any(Number) });
      expect(st().focus!.nonce).toBeGreaterThan(nonce);
      st().selectObject('ceres');
      expect(st().frame).toBe('body-moon');
      st().selectObject('iss');
      expect(focusState()).toEqual({ selectedId: 'iss', frame: 'body-moon', frameLocked: true, follow: true });
    });

    it('fly false selects (and frames) without a camera request or a change of follow', () => {
      const before = st().focus;
      st().selectObject('body-moon', { fly: false });
      expect(focusState()).toEqual({ selectedId: 'body-moon', frame: 'body-moon', frameLocked: false, follow: false });
      expect(st().focus).toBe(before);
    });

    it('an id that is not in the catalog is ignored', () => {
      st().selectObject('body-moon');
      const before = { ...focusState(), focus: st().focus };
      st().selectObject('nope');
      st().selectObject('MOON'); // a registry id is not an entity id
      expect({ ...focusState(), focus: st().focus }).toEqual(before);
    });
  });

  describe('deselect and the home view', () => {
    it('deselecting clears the selection and follow, sends an unlocked frame to the Earth, and asks the camera for nothing', () => {
      st().selectObject('body-mars');
      const request = st().focus;
      st().selectObject(null);
      expect(focusState()).toEqual({ selectedId: null, frame: 'body-earth', frameLocked: false, follow: false });
      expect(st().focus).toBe(request);
    });

    it('a locked frame survives a deselect', () => {
      st().selectObject('lro');
      st().setFrame('lro', true);
      st().selectObject(null);
      expect(focusState()).toEqual({ selectedId: null, frame: 'lro', frameLocked: true, follow: false });
    });

    it('resetView is the home view: deselected, not following, Earth frame, unlocked, one camera request without a target', () => {
      st().selectObject('lro');
      st().setFrame('lro', true);
      const nonce = st().focus!.nonce;
      st().resetView();
      expect(focusState()).toEqual({ selectedId: null, frame: 'body-earth', frameLocked: false, follow: false });
      expect(st().focus).toEqual({ nonce: nonce + 1 });
    });
  });

  describe('setFrame', () => {
    it('sets only the frame and, when given, the lock: no selection, follow or camera request', () => {
      st().selectObject('iss');
      const before = st().focus;
      st().setFrame('iss', true);
      expect(focusState()).toEqual({ selectedId: 'iss', frame: 'iss', frameLocked: true, follow: true });
      expect(st().focus).toBe(before);
      st().setFrame('body-moon'); // no lock argument: unchanged
      expect(focusState()).toMatchObject({ frame: 'body-moon', frameLocked: true });
      st().setFrame('body-moon', false);
      expect(st().frameLocked).toBe(false);
      st().setFrameLocked(true);
      expect(st().frameLocked).toBe(true);
    });

    it('ignores an entity that is not in the catalog', () => {
      st().setFrame('gone', true);
      expect(focusState()).toMatchObject({ frame: 'body-earth', frameLocked: false });
    });
  });

  describe('a catalog that changes under the focus', () => {
    it('a full catalog without the selected entity clears the selection and follow', () => {
      st().selectObject('iss');
      st().upsertEntities(catalog().filter((r) => r.id !== 'iss'), true);
      expect(focusState()).toMatchObject({ selectedId: null, follow: false });
    });

    it('a full catalog without the frame entity sends the frame to the Earth, unlocked', () => {
      st().selectObject('lro');
      st().setFrame('lro', true);
      st().upsertEntities(catalog().filter((r) => r.id !== 'lro'), true);
      expect(focusState()).toMatchObject({ selectedId: null, frame: 'body-earth', frameLocked: false });
    });

    it('an incremental upsert, or a full catalog that still has them, changes nothing', () => {
      st().selectObject('body-moon');
      st().upsertEntities([rec('new')]);
      st().upsertEntities(catalog(), true);
      expect(focusState()).toEqual({ selectedId: 'body-moon', frame: 'body-moon', frameLocked: false, follow: true });
    });
  });

  describe('a locked frame through a whole session (the lock matrix at the store level)', () => {
    const sequences: [string, string, string][] = [['iss', 'lro', 'plain on plain'], ['lro', 'iss', 'plain on plain, the other way'], ['body-moon', 'iss', 'a body, then a plain object'], ['iss', 'body-mars', 'a plain object, then a body'], ['ceres', 'body-moon', 'an orbitable asteroid, then a body']];
    for (const [lock, other, what] of sequences) {
      it(`${what}: lock ${lock}, select ${other}, deselect, select it again: the frame never moves, the selection and camera do`, () => {
        st().selectObject(lock);
        st().setFrame(lock, true);
        st().selectObject(other);
        expect(focusState()).toEqual({ selectedId: other, frame: lock, frameLocked: true, follow: true });
        st().selectObject(null);
        expect(focusState()).toMatchObject({ selectedId: null, frame: lock, frameLocked: true });
        st().selectObject(other);
        st().upsertEntities(catalog(), true); // a refreshed full catalog that still has both
        expect(focusState()).toMatchObject({ selectedId: other, frame: lock, frameLocked: true });
        st().setFrameLocked(false);
        expect(st().frame).toBe(lock); // unlocking does not move it by itself
        st().resetView();
        expect(focusState()).toEqual({ selectedId: null, frame: EARTH_CENTRE, frameLocked: false, follow: false });
      });
    }

    it('locking the Earth (the default frame) locks it: selecting a body then keeps the Earth', () => {
      st().setFrameLocked(true);
      st().selectObject('body-moon');
      expect(focusState()).toMatchObject({ selectedId: 'body-moon', frame: EARTH_CENTRE, frameLocked: true });
    });
  });

  describe('focusLaunch', () => {
    const launch = (extra: Partial<Launch>): Launch => ({ id: 'l1', name: 'L', entityId: 'nope', net: '2026-11-01T00:00:00Z', ...extra }) as Launch;

    it('a launch with an entity is selectObject of it', () => {
      st().focusLaunch(launch({ entityId: 'iss' }));
      expect(focusState()).toEqual({ selectedId: 'iss', frame: 'body-earth', frameLocked: false, follow: true });
      expect(st().focus).toMatchObject({ id: 'iss' });
    });

    it('a launch without one deselects, follows and flies to the pad point', () => {
      st().selectObject('body-moon');
      st().focusLaunch(launch({ pad: { name: 'p', latitude: 28.5, longitude: -80.6 } as Launch['pad'] }));
      expect(focusState()).toEqual({ selectedId: null, frame: 'body-earth', frameLocked: false, follow: true });
      expect(st().focus).toMatchObject({ lat: 28.5, lon: -80.6 });
    });
  });

  it('every UI route selects through selectObject; only the lock button sets a frame by itself', () => {
    const sources = import.meta.glob('../src/ui/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const calls = (re: RegExp) => Object.entries(sources)
      .filter(([, text]) => re.test(text))
      .map(([f]) => f.replace('../src/ui/', ''))
      .sort();
    // the routes: tree and list rows (EntityBrowser), breadcrumb (FrameBar), scene clicks and the popup (SceneView), DSN, detail
    expect(calls(/selectObject/)).toEqual(['DetailPanel.tsx', 'DsnSection.tsx', 'EntityBrowser.tsx', 'FrameBar.tsx', 'ObservatoryPanel.tsx', 'SceneView.tsx']);
    expect(calls(/s\.setFrame\b|getState\(\)\.setFrame\b/)).toEqual(['DetailPanel.tsx']); // (the scene's own ctl.setFrame is the mirror of the store)
    expect(calls(/s\.select\b|getState\(\)\.select\(|[{,]\s*select\s*[,}]/)).toEqual([]); // the old, differently-behaving entry point is gone
    expect(calls(/bodyTabs|role="tablist" aria-label="Body"/)).toEqual([]); // and so are the top-bar body tabs
  });

  describe('body entities', () => {
    it('selecting a body makes it the frame (Earth, Moon, Mars, Sun) unless locked, and an ordinary object leaves it', () => {
      for (const id of ['body-moon', 'body-mars', 'body-sun', 'body-earth']) {
        st().selectObject(id);
        expect(st().frame).toBe(id);
      }
      expect(st().frame).toBe(EARTH_CENTRE);
      st().selectObject('body-moon');
      st().selectObject('iss');
      expect(st().frame).toBe('body-moon');
    });
  });
});

describe('frame persistence', () => {
  const mem = (init: Record<string, string> = {}) => {
    const data = new Map(Object.entries(init));
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };
  const saved = globalThis.localStorage;
  beforeEach(() => {
    useStore.setState({ ...HOME, entities: new Map() });
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = saved;
    useStore.setState({ ...HOME });
  });
  const install = (m: ReturnType<typeof mem>) => { (globalThis as { localStorage?: unknown }).localStorage = m; };

  it('remembers the frame whenever it changes (selecting a body, setFrame, resetView), but not the lock', () => {
    const m = mem();
    install(m);
    st().upsertEntities(catalog());
    st().selectObject('body-mars');
    expect(parseFrame(m.data.get('eio.frame'))).toBe('body-mars');
    st().setFrame('lro', true);
    expect(parseFrame(m.data.get('eio.frame'))).toBe('lro');
    expect(m.data.get('eio.frame')).not.toMatch(/lock/i);
    st().resetView();
    expect(parseFrame(m.data.get('eio.frame'))).toBe(EARTH_CENTRE);
  });

  it('restores a stored frame when the first full catalog arrives: unlocked, selected and flown to', () => {
    install(mem({ 'eio.frame': serialiseFrame('lro') }));
    useStore.setState({ frameLocked: true });
    armFrameRestore();
    st().upsertEntities(catalog(), true);
    expect(focusState()).toEqual({ selectedId: 'lro', frame: 'lro', frameLocked: false, follow: true });
    expect(st().focus).toMatchObject({ id: 'lro' });
  });

  it('restores Mars and Moon frames, including the previous format {kind:"body",id:"MARS"}', () => {
    for (const [stored, expected] of [
      [serialiseFrame('body-mars'), 'body-mars'],
      ['{"kind":"body","id":"MARS"}', 'body-mars'],
      ['{"kind":"body","id":"MOON"}', 'body-moon'],
      ['{"kind":"entity","id":"body-moon"}', 'body-moon'],
    ]) {
      useStore.setState({ ...HOME, entities: new Map() });
      install(mem({ 'eio.frame': stored })); // after the reset: a frame change writes to the installed storage
      armFrameRestore();
      st().upsertEntities(catalog(), true);
      expect(focusState()).toEqual({ selectedId: expected, frame: expected, frameLocked: false, follow: true });
      expect(st().focus).toMatchObject({ id: expected });
    }
  });

  it('a stale entity or an unknown body falls back to the Earth and the stored value is replaced', () => {
    for (const stale of [serialiseFrame('gone'), '{"kind":"body","id":"XENA"}']) {
      const m = mem({ 'eio.frame': stale });
      useStore.setState({ ...HOME, entities: new Map() });
      install(m);
      armFrameRestore();
      st().upsertEntities(catalog(), true);
      expect(focusState()).toMatchObject({ selectedId: null, frame: 'body-earth' });
      expect(parseFrame(m.data.get('eio.frame'))).toBe(EARTH_CENTRE);
    }
  });

  it('a frame the user already changed before the catalog arrived wins; incremental upserts restore nothing', () => {
    install(mem({ 'eio.frame': serialiseFrame('body-mars') }));
    useStore.setState({ entities: new Map(), frame: 'body-moon' });
    armFrameRestore();
    st().upsertEntities(catalog(), true);
    expect(st().frame).toBe('body-moon');
    useStore.setState({ frame: EARTH_CENTRE });
    armFrameRestore();
    st().upsertEntities([rec('x')]); // not a full load
    expect(st().frame).toBe(EARTH_CENTRE);
  });

  it('survives a missing or throwing storage', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); },
    };
    armFrameRestore();
    expect(() => st().upsertEntities(catalog(), true)).not.toThrow();
    expect(() => st().selectObject('body-moon')).not.toThrow();
    expect(st().frame).toBe('body-moon');
  });
});

describe('describing the frame for display', () => {
  beforeEach(() => {
    useStore.setState({ ...HOME, entities: new Map() });
    st().upsertEntities(catalog(), true);
  });

  it('labels and chains the frame through the body entities', () => {
    st().setFrame('lro', true);
    const info = frameInfoOf(st());
    expect(info.label).toBe('LRO');
    expect(info.chain).toBe('Sun > Earth > Moon > LRO');
    expect(info.crumbs.map((c) => c.id)).toEqual(['body-sun', 'body-earth', 'body-moon', 'lro']);
    expect(info.locked).toBe(true);
    expect(info.isDefault).toBe(false);
    st().setFrameLocked(false);
    st().selectObject('body-moon');
    expect(frameInfoOf(st()).chain).toBe('Sun > Earth > Moon');
  });

  it('names the default frame before the catalog has arrived', () => {
    const info = frameInfoOf({ frame: EARTH_CENTRE, frameLocked: false, entities: new Map() });
    expect(info.isDefault).toBe(true);
    expect(info.chain).toBe('Sun > Earth');
  });
});
