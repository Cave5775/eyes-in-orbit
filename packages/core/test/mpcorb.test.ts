import { describe, expect, it } from 'vitest';
import {
  AU_KM, OrbitBuilder, SUN, designationCode, designationText, eclipticToEquatorial, keplerState, mpcToKepler, orbitAt, packedEpochMs,
  parseMpcorbLine, readContainer, readMpcorb, sliceOrbits, DEG, type MpcOrbit,
  MPCORB_SAMPLE,
} from '../src';

const LINES = MPCORB_SAMPLE.split('\n');
const DATA = LINES.filter((l: string) => /^\d{5} /.test(l));

describe('packed designations (examples of the MPC page PackedDes.html)', () => {
  it('numbered', () => {
    const cases: [string, number][] = [['03202', 3202], ['50000', 50000], ['A0345', 100345], ['a0017', 360017], ['K3289', 203289], ['~0000', 620000], ['~000z', 620061], ['~AZaz', 3140113], ['~zzzz', 15396335]];
    for (const [p, n] of cases) {
      expect(designationCode(p)).toBe(n);
      expect(designationText(n)).toBe(String(n));
    }
  });
  it('provisional and survey', () => {
    const cases: [string, string][] = [
      ['J95X00A', '1995 XA'], ['J95X01L', '1995 XL1'], ['J95F13B', '1995 FB13'], ['J98SA8Q', '1998 SQ108'], ['J98SC7V', '1998 SV127'],
      ['J98SG2S', '1998 SS162'], ['K99AJ3Z', '2099 AZ193'], ['K08Aa0A', '2008 AA360'], ['K07Tf8A', '2007 TA418'],
      ['PLS2040', '2040 P-L'], ['T1S3138', '3138 T-1'], ['T2S1010', '1010 T-2'], ['T3S4101', '4101 T-3'],
    ];
    for (const [p, text] of cases) {
      const code = designationCode(p);
      expect(code, p).not.toBeNull();
      expect(designationText(code as number)).toBe(text);
    }
  });
  it('refuses what it does not know', () => {
    for (const p of ['', '1234', '_LK01AB', 'K99AJ3', 'X95X00A', 'J95I00A', 'AB0345', 'A03x5', '~00!0']) expect(designationCode(p), p).toBeNull();
  });
});

describe('packed epochs (PackedDates.html)', () => {
  it('decodes century, month and day', () => {
    expect(packedEpochMs('K2669')).toBe(Date.UTC(2026, 5, 9));
    expect(packedEpochMs('K01AM')).toBe(Date.UTC(2001, 9, 22));
    expect(packedEpochMs('J9611')).toBe(Date.UTC(1996, 0, 1));
    expect(packedEpochMs('K26CV')).toBe(Date.UTC(2026, 11, 31));
  });
  it('refuses impossible dates', () => {
    for (const p of ['K26D1', 'K2602', 'K2630', 'K26AW', 'L2669', 'K266', 'K2661x']) expect(packedEpochMs(p), p).toBeNull();
  });
});

describe('parseMpcorbLine on the real lines', () => {
  it('reads Ceres from the documented columns', () => {
    const o = parseMpcorbLine(DATA[0]) as MpcOrbit;
    expect(o).toMatchObject({ packed: '00001', h: 3.34, m0Deg: 274.41935, argpDeg: 73.2942, nodeDeg: 80.24863, incDeg: 10.58803, e: 0.0796923, aAu: 2.7655526 });
    expect(o.epochMs).toBe(Date.UTC(2026, 5, 9));
  });
  it('reads all 20 lines', () => {
    expect(DATA).toHaveLength(20);
    for (const l of DATA) expect(parseMpcorbLine(l), l).not.toBeNull();
  });
  it('skips lines it cannot read instead of guessing', () => {
    const l = DATA[1];
    const bad: Record<string, string> = {
      header: LINES[0] || 'MINOR PLANET CENTER ORBIT DATABASE (MPCORB)',
      columnHeads: LINES.find((x: string) => x.startsWith("Des'n")) as string,
      truncated: l.slice(0, 90),
      shiftedRight: ` ${l}`,
      letterInNumber: `${l.slice(0, 26)}27x.24963${l.slice(35)}`,
      eTooBig: `${l.slice(0, 70)}1.2307001${l.slice(79)}`,
      aZero: `${l.slice(0, 92)}  0.0000000${l.slice(103)}`,
      badEpoch: `${l.slice(0, 20)} K2699${l.slice(26)}`.replace(' K', 'K').padEnd(l.length),
      badDesignation: `~~~~~${l.slice(5)}`,
      inclinationOver180: `${l.slice(0, 59)}190.00000${l.slice(68)}`,
    };
    for (const [k, v] of Object.entries(bad)) expect(parseMpcorbLine(v), k).toBeNull();
  });
  it('accepts a blank H (unknown) and shorter tails', () => {
    const l = DATA[2];
    const o = parseMpcorbLine(`${l.slice(0, 8)}     ${l.slice(13, 103)}`) as MpcOrbit;
    expect(o.h).toBeNull();
    expect(o.aAu).toBe(2.6709895);
  });
});

describe('readMpcorb', () => {
  it('counts parsed and skipped lines, ignores the header and blank separators', async () => {
    const lines = [...LINES.slice(0, -1), '', DATA[0].slice(0, 100), 'garbage', DATA[5], '', ''];
    const b = new OrbitBuilder();
    const s = await readMpcorb(lines, b);
    expect(s.parsed).toBe(21);
    expect(s.skipped).toBe(2);
    expect(s.samples).toHaveLength(2);
    expect(b.count).toBe(21);
  });
  it('accepts CRLF line ends', async () => {
    const b = new OrbitBuilder();
    const s = await readMpcorb(DATA.map((l) => `${l}\r`), b);
    expect(s).toMatchObject({ parsed: 20, skipped: 0 });
  });
});

describe('packed layout', () => {
  const build = async (lines: string[] = LINES) => {
    const b = new OrbitBuilder();
    const s = await readMpcorb(lines, b);
    return b.finish({ skipped: s.skipped, source: 'test' });
  };
  const headBytes = (metaJson: string): number => 16 + Math.ceil(metaJson.length / 4) * 4;

  it('is 32 bytes per orbit (plus 4 for an odd count) after the header, sorted by H, unknown H last', async () => {
    const noH = `${DATA[3].slice(0, 8)}     ${DATA[3].slice(13)}`;
    const bytes = await build([...DATA, noH]);
    const u = readContainer(bytes);
    expect(u.count).toBe(21);
    expect(bytes.length).toBe(headBytes(JSON.stringify(u.meta)) + 32 * 21 + 4);
    const hs = Array.from(u.h);
    expect(hs.slice(0, 20)).toEqual([...hs.slice(0, 20)].sort((a, b) => a - b));
    expect(hs[20]).toBe(65535);
    expect(designationText(u.desig[0])).toBe('4'); // Vesta, H 3.25, the brightest of the fixture
    expect(u.meta).toMatchObject({ parsed: 21, skipped: 0, source: 'test', hMin: 3.25 });
    expect(u.meta.epochMin).toBe(Date.UTC(2026, 5, 9));
  });

  it('round-trips every field within the quantisation', async () => {
    const u = readContainer(await build());
    const want = new Map(DATA.map((l: string) => [Number(l.slice(0, 5)), parseMpcorbLine(l) as MpcOrbit]));
    for (let i = 0; i < u.count; i++) {
      const o = orbitAt(u, i);
      const w = want.get(Number(o.designation)) as MpcOrbit;
      expect(o.h).toBeCloseTo(w.h as number, 2);
      expect(o.epochMs).toBe(w.epochMs);
      for (const k of ['m0Deg', 'argpDeg', 'nodeDeg', 'incDeg'] as const) expect(Math.abs(o[k] - w[k])).toBeLessThan(1e-7);
      expect(Math.abs(o.e - w.e)).toBeLessThan(3e-10);
      expect(Math.abs(o.aAu - w.aAu) / w.aAu).toBeLessThan(1e-7);
    }
  });

  it('slices a chunk that is a container of its own', async () => {
    const u = readContainer(await build());
    const chunk = readContainer(sliceOrbits(u, 5, 12));
    expect(chunk.count).toBe(7);
    expect(Array.from(chunk.desig)).toEqual(Array.from(u.desig.subarray(5, 12)));
    expect(Array.from(chunk.a)).toEqual(Array.from(u.a.subarray(5, 12)));
    expect(readContainer(sliceOrbits(u, 18, 99)).count).toBe(2);
    expect(readContainer(sliceOrbits(u, 30, 99)).count).toBe(0);
  });

  it('reads an unaligned buffer and refuses foreign or truncated ones', async () => {
    const bytes = await build();
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    expect(readContainer(shifted.subarray(1)).count).toBe(20);
    expect(() => readContainer(bytes.subarray(0, bytes.length - 4))).toThrow(/expected/);
    expect(() => readContainer(new Uint8Array(40))).toThrow(/not an MPCB/);
    expect(() => readContainer(new Uint8Array(3))).toThrow(/truncated/);
  });

  it('leaves out an orbit whose epoch the 16-bit day column cannot hold, and counts it', () => {
    const b = new OrbitBuilder();
    const o = parseMpcorbLine(DATA[0]) as MpcOrbit;
    expect(b.add({ ...o, epochMs: Date.UTC(1899, 0, 1) })).toBe(false);
    expect(b.add({ ...o, epochMs: Date.UTC(2090, 0, 1) })).toBe(false);
    expect(b.add(o)).toBe(true);
    expect(readContainer(b.finish({ skipped: 0 })).meta).toMatchObject({ parsed: 1, skipped: 2 });
  });
});

describe('mpcToKepler', () => {
  it('rotates the ecliptic orbit into the equatorial axes: same state as the ecliptic orbit rotated by eclipticToEquatorial', () => {
    for (const l of DATA) {
      const o = parseMpcorbLine(l) as MpcOrbit;
      const ecl = { a: o.aAu * AU_KM, e: o.e, i: o.incDeg * DEG, raan: o.nodeDeg * DEG, argp: o.argpDeg * DEG, m0: o.m0Deg * DEG, epochMs: o.epochMs };
      for (const dtDays of [0, 400, 5000]) {
        const t = o.epochMs + dtDays * 86_400_000;
        const want = eclipticToEquatorial(keplerState(ecl, SUN.gm, t).r);
        const got = keplerState(mpcToKepler(o), SUN.gm, t).r;
        for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k])).toBeLessThan(1e-3); // km, at 3e8 km
      }
    }
  });

  it('puts Ceres at the epoch between its perihelion and aphelion, in a plane tilted by its inclination to the ecliptic', () => {
    const o = parseMpcorbLine(DATA[0]) as MpcOrbit;
    const r = keplerState(mpcToKepler(o), SUN.gm, o.epochMs).r;
    const d = Math.hypot(r[0], r[1], r[2]) / AU_KM;
    expect(d).toBeGreaterThan(o.aAu * (1 - o.e));
    expect(d).toBeLessThan(o.aAu * (1 + o.e));
    // the heliocentric ecliptic latitude cannot exceed the inclination
    const ecl = eclipticToEquatorial(r, -23.4392911 * DEG);
    expect(Math.abs(Math.asin(ecl[2] / (d * AU_KM))) / DEG).toBeLessThanOrEqual(o.incDeg + 1e-9);
  });
});
