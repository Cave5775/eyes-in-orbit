import { describe, expect, it } from 'vitest';
import { chooseSurvey, fallbackNote } from '../src/lib/survey-fallback';

/** A probe where the listed ids have a server. */
const up = (...ids: string[]) => (id: string): Promise<string | null> => Promise.resolve(ids.includes(id) ? `https://mirror/${id}` : null);

describe('chooseSurvey', () => {
  const plan = { own: ['A', 'B'], fallbacks: ['DSS', '2MASS'] };

  it('takes the first own survey when it has a server and does not ask the fallbacks', async () => {
    const asked: string[] = [];
    const c = await chooseSurvey(plan, (id) => { asked.push(id); return up('A', 'DSS')(id); });
    expect(c).toEqual({ id: 'A', value: 'https://mirror/A', requested: 'A', unavailable: [] });
    expect(asked).toEqual(['A', 'B']);
  });

  it('takes the next own survey when the first is down, and says which was down', async () => {
    const c = await chooseSurvey(plan, up('B', 'DSS'));
    expect(c).toMatchObject({ id: 'B', requested: 'A', unavailable: ['A'] });
  });

  it('a quicker survey later in the list never wins over a slower one ahead of it', async () => {
    const c = await chooseSurvey(plan, (id) => new Promise<string | null>((res) => setTimeout(() => res(`u/${id}`), id === 'A' ? 30 : 1)));
    expect(c?.id).toBe('A');
  });

  it('falls back to the all-sky surveys, in order, when no own survey has a server', async () => {
    const c = await chooseSurvey(plan, up('2MASS', 'DSS'));
    expect(c).toMatchObject({ id: 'DSS', requested: 'A', unavailable: ['A', 'B'] });
    const d = await chooseSurvey(plan, up('2MASS'));
    expect(d).toMatchObject({ id: '2MASS', unavailable: ['A', 'B', 'DSS'] });
  });

  it('is null only when nothing answers at all', async () => {
    expect(await chooseSurvey(plan, up())).toBeNull();
    expect(await chooseSurvey({ own: [], fallbacks: [] }, up('A'))).toBeNull();
  });

  it('a probe that throws or hangs counts as down; a repeated id is asked once', async () => {
    const asked: string[] = [];
    const c = await chooseSurvey({ own: ['A', 'A', 'B'], fallbacks: ['DSS'] }, (id) => {
      asked.push(id);
      if (id === 'A') return Promise.reject(new Error('network'));
      if (id === 'B') return new Promise(() => undefined);
      return Promise.resolve('dss-url');
    }, 20);
    expect(c).toMatchObject({ id: 'DSS', value: 'dss-url', unavailable: ['A', 'B'] });
    expect(asked).toEqual(['A', 'B', 'DSS']);
  });

  it('with no own survey the first fallback is the requested one', async () => {
    const c = await chooseSurvey({ own: [], fallbacks: ['DSS', '2MASS'] }, up('2MASS'));
    expect(c).toMatchObject({ id: '2MASS', requested: 'DSS', unavailable: ['DSS'] });
  });
});

describe('fallbackNote', () => {
  it('names both surveys, and is null when the wanted one is in use', () => {
    expect(fallbackNote('Hubble colour', 'DSS2 colour', false)).toBe('Hubble colour is unavailable right now, showing DSS2 colour.');
    expect(fallbackNote('DSS2 colour', 'DSS2 colour', true)).toBeNull();
  });
});
