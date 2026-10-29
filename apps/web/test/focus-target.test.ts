import { describe, expect, it } from 'vitest';
import { focusTarget } from '../src/lib/focus-target';

type R = { id: string; bodyId: string; parentId?: string };
const recs: Record<string, R> = {
  'body-earth': { id: 'body-earth', bodyId: 'EARTH', parentId: 'body-sun' },
  'body-sun': { id: 'body-sun', bodyId: 'SUN' },
  'body-mars': { id: 'body-mars', bodyId: 'MARS', parentId: 'body-sun' },
  'body-moon': { id: 'body-moon', bodyId: 'MOON', parentId: 'body-earth' },
  maven: { id: 'maven', bodyId: 'MARS' },
  lro: { id: 'lro', bodyId: 'MOON' },
  veh: { id: 'veh', bodyId: 'EARTH' },
  pay: { id: 'pay', bodyId: 'EARTH', parentId: 'veh' },
  orphan: { id: 'orphan', bodyId: 'NOWHERE', parentId: 'gone' },
};
const lookup = (id: string) => recs[id];
const has = (...ids: string[]) => (id: string) => id.startsWith('body-') || ids.includes(id);

describe('focusTarget', () => {
  it('a tracked entity is itself', () => {
    expect(focusTarget(recs.maven, lookup, has('maven'))).toEqual({ id: 'maven', untracked: false });
  });
  it('an untracked orbiter shows its primary body', () => {
    expect(focusTarget(recs.maven, lookup, has())).toEqual({ id: 'body-mars', untracked: true });
    expect(focusTarget(recs.lro, lookup, has())).toEqual({ id: 'body-moon', untracked: true });
  });
  it('the parent entity wins over the body', () => {
    expect(focusTarget(recs.pay, lookup, has('veh'))).toEqual({ id: 'veh', untracked: true });
  });
  it('walks up while the parent is untracked too', () => {
    expect(focusTarget(recs.pay, lookup, has())).toEqual({ id: 'body-earth', untracked: true });
  });
  it('a missing parent falls back to the body, nothing known falls back to the Earth', () => {
    expect(focusTarget({ ...recs.orphan, bodyId: 'MARS' }, lookup, has())).toEqual({ id: 'body-mars', untracked: true });
    expect(focusTarget(recs.orphan, lookup, has())).toEqual({ id: 'body-earth', untracked: true });
  });
  it('terminates on cycles', () => {
    const cyc: Record<string, R> = { a: { id: 'a', bodyId: 'X', parentId: 'b' }, b: { id: 'b', bodyId: 'X', parentId: 'a' } };
    expect(focusTarget(cyc.a, (i) => cyc[i], () => false)).toEqual({ id: 'body-earth', untracked: true });
  });
});
