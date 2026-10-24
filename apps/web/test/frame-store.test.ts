import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityRecord } from '@eio/core';
import { EARTH_CENTRE, bodyCentre, entityCentre } from '../src/lib/frame';
import { frameInfoOf, useStore } from '../src/state/store';

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
