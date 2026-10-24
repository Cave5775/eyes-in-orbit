import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bodyEntityRecords, type EntityRecord } from '@eio/core';
import { EARTH_CENTRE, bodyCentre, entityCentre } from '../src/lib/frame';
import { parseFrame, serialiseFrame } from '../src/lib/frame-store';
import { armFrameRestore, frameInfoOf, useStore } from '../src/state/store';

const rec = (id: string, bodyId = 'EARTH'): EntityRecord => ({ id, name: id.toUpperCase(), kind: 'satellite', bodyId, aliases: {}, updatedAt: 0 });

describe('frame state in the store', () => {
  beforeEach(() => {
    useStore.setState({ entities: new Map(), selectedId: null, follow: false, frame: EARTH_CENTRE, frameLocked: false, focus: null });
    useStore.getState().upsertEntities([rec('iss'), rec('sat-b'), rec('lro', 'MOON')], true);
  });

  it('starts at the Earth, unlocked', () => {
    expect(useStore.getState().frame).toEqual(EARTH_CENTRE);
    expect(useStore.getState().frameLocked).toBe(false);
  });

  it('selecting an object moves the camera but never the frame', () => {
    const s = useStore.getState();
    s.select('lro');
    expect(useStore.getState().selectedId).toBe('lro');
    expect(useStore.getState().focus?.id).toBe('lro');
    expect(useStore.getState().frame).toEqual(EARTH_CENTRE);
    s.setFrame(bodyCentre('MOON'));
    useStore.getState().select('iss');
    expect(useStore.getState().frame).toEqual(bodyCentre('MOON'));
  });

  it('setFrame with fly asks the camera to go there: a body deselects, an entity keeps the selection', () => {
    const s = useStore.getState();
    s.select('iss');
    s.setFrame(bodyCentre('MOON'), { fly: true });
    let st = useStore.getState();
    expect(st.frame).toEqual(bodyCentre('MOON'));
    expect(st.selectedId).toBeNull();
    expect(st.focus?.centre).toEqual(bodyCentre('MOON'));
    expect(st.follow).toBe(true);
    st.select('sat-b');
    st.setFrame(entityCentre('iss'), { fly: true });
    st = useStore.getState();
    expect(st.selectedId).toBe('sat-b');
    expect(st.focus?.centre).toEqual(entityCentre('iss'));
    // Earth: the home view
    st.setFrame(EARTH_CENTRE, { fly: true });
    st = useStore.getState();
    expect(st.frame).toEqual(EARTH_CENTRE);
    expect(st.focus?.centre).toBeUndefined();
    expect(st.follow).toBe(false);
  });

  it('setFrame without fly leaves the camera alone', () => {
    const before = useStore.getState().focus;
    useStore.getState().setFrame(bodyCentre('MOON'));
    expect(useStore.getState().focus).toBe(before);
  });

  it('locks the frame to an object: other selections change neither frame nor lock', () => {
    const s = useStore.getState();
    s.select('iss');
    s.setFrame(entityCentre('iss'), { lock: true });
    expect(useStore.getState().frameLocked).toBe(true);
    useStore.getState().select('sat-b');
    useStore.getState().select('MOON'); // even an orbitable body does not take over a locked frame
    const st = useStore.getState();
    expect(st.selectedId).toBe('sat-b');
    expect(st.frame).toEqual(entityCentre('iss'));
    expect(st.frameLocked).toBe(true);
    st.setFrameLocked(false);
    expect(useStore.getState().frameLocked).toBe(false);
  });

  it('selecting an orbitable body re-centres the frame unless locked', () => {
    useStore.getState().select('MOON');
    let st = useStore.getState();
    expect(st.frame).toEqual(bodyCentre('MOON'));
    expect(st.focus?.centre).toEqual(bodyCentre('MOON'));
    useStore.getState().setFrameLocked(true);
    useStore.getState().select('SUN');
    expect(useStore.getState().frame).toEqual(bodyCentre('MOON'));
    st = useStore.getState();
    st.resetView();
    expect(useStore.getState().frame).toEqual(EARTH_CENTRE);
    expect(useStore.getState().frameLocked).toBe(false);
  });

  it('resetView returns to the Earth, unlocked and deselected', () => {
    const s = useStore.getState();
    s.select('iss');
    s.setFrame(entityCentre('iss'), { lock: true, fly: true });
    useStore.getState().resetView();
    const st = useStore.getState();
    expect(st.frame).toEqual(EARTH_CENTRE);
    expect(st.frameLocked).toBe(false);
    expect(st.selectedId).toBeNull();
  });

  describe('body entities', () => {
    beforeEach(() => {
      useStore.setState({ frame: EARTH_CENTRE, frameLocked: false, selectedId: null });
      useStore.getState().upsertEntities([...bodyEntityRecords(), rec('iss')]);
    });

    it('selecting a body entity makes it the frame (Earth, Moon, Mars, Sun), like the tabs', () => {
      useStore.getState().select('body-moon');
      let st = useStore.getState();
      expect(st.selectedId).toBe('body-moon');
      expect(st.frame).toEqual(bodyCentre('MOON'));
      expect(st.focus?.id).toBe('body-moon');
      st.select('body-mars');
      expect(useStore.getState().frame).toEqual(bodyCentre('MARS'));
      useStore.getState().select('body-sun');
      expect(useStore.getState().frame).toEqual(bodyCentre('SUN'));
      useStore.getState().select('body-earth');
      st = useStore.getState();
      expect(st.frame).toEqual(EARTH_CENTRE);
      expect(st.frameLocked).toBe(false);
    });

    it('selecting an ordinary object never changes the frame', () => {
      useStore.getState().select('body-moon');
      useStore.getState().select('iss');
      expect(useStore.getState().frame).toEqual(bodyCentre('MOON'));
    });

    it('a locked frame never changes on selecting a body entity, the selection still moves', () => {
      useStore.getState().setFrame(bodyCentre('MOON'), { lock: true });
      useStore.getState().select('body-mars');
      const st = useStore.getState();
      expect(st.selectedId).toBe('body-mars');
      expect(st.frame).toEqual(bodyCentre('MOON'));
      expect(st.frameLocked).toBe(true);
    });

    it('deselecting keeps the frame', () => {
      useStore.getState().select('body-mars');
      useStore.getState().select(null);
      expect(useStore.getState().frame).toEqual(bodyCentre('MARS'));
    });
  });

  describe('frame persistence', () => {
    const mem = (init: Record<string, string> = {}) => {
      const data = new Map(Object.entries(init));
      return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
    };
    const saved = globalThis.localStorage;
    afterEach(() => {
      (globalThis as { localStorage?: unknown }).localStorage = saved;
      useStore.setState({ frame: EARTH_CENTRE, frameLocked: false });
    });
    const install = (m: ReturnType<typeof mem>) => { (globalThis as { localStorage?: unknown }).localStorage = m; };
    const catalog = () => [...bodyEntityRecords(), rec('iss'), rec('lro', 'MOON')];

    it('remembers the frame on setFrame, select and resetView, but not the lock', () => {
      const m = mem();
      install(m);
      useStore.getState().setFrame(bodyCentre('MARS'), { lock: true });
      expect(parseFrame(m.data.get('eio.frame'))).toEqual(bodyCentre('MARS'));
      expect(m.data.get('eio.frame')).not.toMatch(/lock/i);
      useStore.getState().setFrameLocked(false);
      useStore.getState().upsertEntities(bodyEntityRecords());
      useStore.getState().setFrame(entityCentre('iss'));
      expect(parseFrame(m.data.get('eio.frame'))).toEqual(entityCentre('iss'));
      useStore.getState().select('body-moon');
      expect(parseFrame(m.data.get('eio.frame'))).toEqual(bodyCentre('MOON'));
      useStore.getState().resetView();
      expect(parseFrame(m.data.get('eio.frame'))).toEqual(EARTH_CENTRE);
    });

    it('restores a stored frame when the first full catalog arrives, unlocked, and flies there', () => {
      install(mem({ 'eio.frame': serialiseFrame(entityCentre('lro')) }));
      useStore.setState({ entities: new Map(), frame: EARTH_CENTRE, frameLocked: true, focus: null });
      armFrameRestore();
      useStore.getState().upsertEntities(catalog(), true);
      const st = useStore.getState();
      expect(st.frame).toEqual(entityCentre('lro'));
      expect(st.focus?.centre).toEqual(entityCentre('lro'));
    });

    it('restores a body centre, and an unlocked state (the lock is never persisted)', () => {
      install(mem({ 'eio.frame': serialiseFrame(bodyCentre('MARS')) }));
      useStore.setState({ entities: new Map(), frame: EARTH_CENTRE, frameLocked: false });
      armFrameRestore();
      useStore.getState().upsertEntities(catalog(), true);
      expect(useStore.getState().frame).toEqual(bodyCentre('MARS'));
      expect(useStore.getState().frameLocked).toBe(false);
    });

    it('a stale entity or an unknown body falls back to the Earth and the stored value is replaced', () => {
      for (const stale of [entityCentre('gone'), bodyCentre('PLUTO')]) {
        const m = mem({ 'eio.frame': serialiseFrame(stale) });
        install(m);
        useStore.setState({ entities: new Map(), frame: EARTH_CENTRE, frameLocked: false });
        armFrameRestore();
        useStore.getState().upsertEntities(catalog(), true);
        expect(useStore.getState().frame).toEqual(EARTH_CENTRE);
        expect(parseFrame(m.data.get('eio.frame'))).toEqual(EARTH_CENTRE);
      }
    });

    it('a frame the user already changed before the catalog arrived wins; incremental upserts restore nothing', () => {
      install(mem({ 'eio.frame': serialiseFrame(bodyCentre('MARS')) }));
      useStore.setState({ entities: new Map(), frame: bodyCentre('MOON') });
      armFrameRestore();
      useStore.getState().upsertEntities(catalog(), true);
      expect(useStore.getState().frame).toEqual(bodyCentre('MOON'));
      useStore.setState({ frame: EARTH_CENTRE });
      armFrameRestore();
      useStore.getState().upsertEntities([rec('x')]); // not a full load
      expect(useStore.getState().frame).toEqual(EARTH_CENTRE);
    });

    it('survives a missing or throwing storage', () => {
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); },
      };
      useStore.setState({ entities: new Map() });
      armFrameRestore();
      expect(() => useStore.getState().upsertEntities(catalog(), true)).not.toThrow();
      expect(() => useStore.getState().setFrame(bodyCentre('MOON'))).not.toThrow();
      expect(useStore.getState().frame).toEqual(bodyCentre('MOON'));
    });
  });

  it('describes the frame for display', () => {
    const st = useStore.getState();
    st.setFrame(entityCentre('lro'), { lock: true });
    const info = frameInfoOf(useStore.getState());
    expect(info.label).toBe('LRO');
    expect(info.chain).toBe('SUN > EARTH > MOON > LRO');
    expect(info.locked).toBe(true);
    expect(info.isDefault).toBe(false);
    expect(frameInfoOf({ frame: EARTH_CENTRE, frameLocked: false, entities: new Map() }).isDefault).toBe(true);
  });
});
