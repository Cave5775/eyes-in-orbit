import { describe, expect, it } from 'vitest';
import { FAILED_RETRY_MS, MirrorPicker, firstReachable } from '../src/lib/hips-mirror';
import { SURVEYS } from '../src/lib/observatories';

const A = 'https://alasky.cds.unistra.fr/DSS/DSSColor';
const B = 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color';
const C = 'https://skies.esac.esa.int/DSSColor';

/** a probe that answers from a set and records every call */
function probeOf(up: Set<string>) {
  const calls: string[] = [];
  const probe = async (base: string) => {
    calls.push(base);
    if (base === 'throws') throw new Error('network');
    return up.has(base);
  };
  return { probe, calls };
}

describe('firstReachable', () => {
  it('takes the first mirror that answers and stops there', async () => {
    const { probe, calls } = probeOf(new Set([B, C]));
    expect(await firstReachable([A, B, C], probe)).toBe(B);
    expect(calls).toEqual([A, B]);
  });

  it('a throwing probe is a miss; none answering gives null', async () => {
    const { probe } = probeOf(new Set());
    expect(await firstReachable(['throws', A], probe)).toBeNull();
  });
});

describe('MirrorPicker', () => {
  it('probes a survey once per session when a mirror works', async () => {
    const { probe, calls } = probeOf(new Set([B]));
    const p = new MirrorPicker(probe, () => 0);
    expect(await p.pick('dss', [A, B])).toBe(B);
    expect(await p.pick('dss', [A, B])).toBe(B);
    expect(calls).toEqual([A, B]);
  });

  it('shares one probe between concurrent asks', async () => {
    const { probe, calls } = probeOf(new Set([A]));
    const p = new MirrorPicker(probe, () => 0);
    const [x, y] = await Promise.all([p.pick('dss', [A]), p.pick('dss', [A])]);
    expect([x, y]).toEqual([A, A]);
    expect(calls).toEqual([A]);
  });

  it('a survey with no working mirror is asked again only after FAILED_RETRY_MS', async () => {
    let now = 0;
    const up = new Set<string>();
    const { probe, calls } = probeOf(up);
    const p = new MirrorPicker(probe, () => now);
    expect(await p.pick('rass', [A])).toBeNull();
    now = FAILED_RETRY_MS - 1;
    expect(await p.pick('rass', [A])).toBeNull();
    expect(calls).toHaveLength(1);
    up.add(A);
    now = FAILED_RETRY_MS;
    expect(await p.pick('rass', [A])).toBe(A);
    expect(calls).toHaveLength(2);
  });
});

describe('current mirror', () => {
  it('reports the found server for display, undefined before and when none answers', async () => {
    const { probe } = probeOf(new Set([A]));
    const p = new MirrorPicker(probe);
    expect(p.current('dss')).toBeUndefined();
    await p.pick('dss', [A]);
    expect(p.current('dss')).toBe(A);
    await p.pick('none', ['https://down.example/x']);
    expect(p.current('none')).toBeUndefined();
  });
});

describe('survey list', () => {
  it('every survey has servers (every survey is listed over https: the browser cannot use http servers without CORS), no trailing slash, and the servers that answered on 2026-11-16 come before CDS', () => {
    for (const s of SURVEYS) {
      expect(s.urls.length).toBeGreaterThan(0);
      for (const u of s.urls) expect(u, s.id).toMatch(/^https:\/\/[^/]+\/\S+[^/]$/);
      const firstCds = s.urls.findIndex((u) => /cds\.unistra\.fr/.test(u));
      const answering = s.urls.findIndex((u) => /irsa\.ipac|casda|stpubdata|cdaftp|padc-web|surveys\.roe|xcatdb/.test(u));
      if (firstCds >= 0 && answering >= 0) expect(answering, s.id).toBeLessThan(firstCds);
    }
  });
});
