/**
 * How the bodies of the registry LOOK (the web side only: the core registry holds physics, not appearance). One table keyed by
 * registry id; a body without an entry is a neutral grey sphere (`DEFAULT_STYLE`), so a body added to the registry needs no code
 * here to be drawn. See docs/frames.md, "Adding a body".
 *
 * The colours are APPROXIMATE DISPLAY COLOURS read off commonly published mean colours and images (NASA/JPL/USGS imagery
 * descriptions, planetary fact sheets); they are not measurements (no calibrated albedo or spectrum), only enough that Venus
 * reads cream, Mars rust, Io sulphur yellow. Hex colours are the sRGB-like values the body shader outputs directly.
 */

export interface BandStyle {
  /** the two colours the latitudinal bands alternate between (hex) */
  colors: [string, string];
  /** bands pole to pole (a few: Jupiter 7, Saturn 5, the ice giants almost none) */
  count: number;
  /** how strongly the bands show, 0..1 */
  contrast: number;
}

/** A ring system in the body's equatorial plane. Radii from the body's centre, km. */
export interface RingStyle {
  innerKm: number;
  outerKm: number;
  /** radial segments `{fromKm, toKm, alpha, color}` (opacity 0..1) drawn over `[innerKm, outerKm]`; gaps are segments with a low alpha. Absent: one uniform ring. */
  segments?: { fromKm: number; toKm: number; alpha: number; color: string }[];
}

export interface BodyStyle {
  /** mean colour (hex); also the colour of the small marker */
  color: string;
  /** latitudinal band pattern (gas and ice giants) */
  bands?: BandStyle;
  /** amount of albedo noise on a solid surface, 0 (smooth) .. 0.5; default `DEFAULT_NOISE` */
  noise?: number;
  rings?: RingStyle;
}

/** Albedo noise of a solid body that does not say. */
export const DEFAULT_NOISE = 0.18;

export const DEFAULT_STYLE: BodyStyle = { color: '#8c8c90' };

/**
 * Saturn's rings, 74,500 km (inner edge of the C ring) to 136,800 km (outer edge of the A ring), from the NASA Saturn fact
 * sheet. Opacities are a coarse reading of the usual ring images: C faint, B dense, the Cassini division (about 117,600 to
 * 122,200 km) nearly clear, A moderate (the narrow Encke gap is ignored).
 */
export const SATURN_RINGS: RingStyle = {
  innerKm: 74_500,
  outerKm: 136_800,
  segments: [
    { fromKm: 74_500, toKm: 92_000, alpha: 0.14, color: '#6f6a62' }, // C ring
    { fromKm: 92_000, toKm: 117_600, alpha: 0.88, color: '#cdb98f' }, // B ring
    { fromKm: 117_600, toKm: 122_200, alpha: 0.06, color: '#8a8070' }, // Cassini division
    { fromKm: 122_200, toKm: 136_800, alpha: 0.5, color: '#bfae88' }, // A ring
  ],
};

export const BODY_STYLES: Record<string, BodyStyle> = {
  SUN: { color: '#fff1cf' },
  EARTH: { color: '#3d6fb5' },
  MOON: { color: '#a8a8a4' },
  MARS: { color: '#bd5c33' },
  MERCURY: { color: '#8c8279', noise: 0.25 },
  VENUS: { color: '#e3cf9f', noise: 0.04, bands: { colors: ['#e8d7a8', '#d9c18a'], count: 3, contrast: 0.25 } },
  JUPITER: { color: '#d2b48c', bands: { colors: ['#eadcc0', '#b5814f'], count: 9, contrast: 0.85 } },
  SATURN: { color: '#e3d19a', bands: { colors: ['#eee0b2', '#cdb27a'], count: 7, contrast: 0.55 }, rings: SATURN_RINGS },
  URANUS: { color: '#a9dde0', bands: { colors: ['#b4e4e6', '#9fd3d8'], count: 3, contrast: 0.2 } },
  NEPTUNE: { color: '#4a6fe3', bands: { colors: ['#5d84f2', '#3a56c0'], count: 5, contrast: 0.45 } },
  CERES: { color: '#6e6c6a' },
  PLUTO: { color: '#c4a484', noise: 0.3 },
  ERIS: { color: '#e8e4dc', noise: 0.08 },
  HAUMEA: { color: '#e0e0e0', noise: 0.08 },
  MAKEMAKE: { color: '#c58a64' },
  PHOBOS: { color: '#6b5f55', noise: 0.3 },
  DEIMOS: { color: '#8a7c6c', noise: 0.25 },
  IO: { color: '#e6d35a', noise: 0.28 },
  EUROPA: { color: '#cfc3a5', noise: 0.12 },
  GANYMEDE: { color: '#8d8478', noise: 0.28 },
  CALLISTO: { color: '#5c5248', noise: 0.25 },
  MIMAS: { color: '#aaaaaa' },
  ENCELADUS: { color: '#f5f7fa', noise: 0.05 },
  TETHYS: { color: '#dcdcdc', noise: 0.1 },
  DIONE: { color: '#d0d0cc' },
  RHEA: { color: '#c4c1ba' },
  TITAN: { color: '#d9922e', noise: 0.05 },
  IAPETUS: { color: '#a89f90', noise: 0.35 },
  MIRANDA: { color: '#aaa8a4' },
  ARIEL: { color: '#b8b6b0' },
  UMBRIEL: { color: '#6f6e6c' },
  TITANIA: { color: '#9c948a' },
  OBERON: { color: '#8a7f77' },
  TRITON: { color: '#e6d6d0', noise: 0.1 },
  CHARON: { color: '#8f8a88' },
};

/** The style of a body: its entry, or the neutral grey. */
export const bodyStyle = (id: string): BodyStyle => BODY_STYLES[id] ?? DEFAULT_STYLE;

/** `#rrggbb` to [r, g, b] in 0..1 (unparsable: the default grey, so a typo shows as grey not black). */
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1], 16) : 0x8c8c90;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Opacity and colour of a ring at radius `rKm` (alpha 0 outside the ring). Pure: the ring texture is this function sampled. */
export function ringSample(ring: RingStyle, rKm: number): { alpha: number; rgb: [number, number, number] } {
  if (!(rKm >= ring.innerKm && rKm <= ring.outerKm)) return { alpha: 0, rgb: [0, 0, 0] };
  const seg = ring.segments?.find((s) => rKm >= s.fromKm && rKm <= s.toKm);
  if (!seg) return { alpha: 0.5, rgb: [0.75, 0.7, 0.62] };
  // fine structure: a deterministic ripple of a few percent so the ring is not a flat tone
  const rip = 1 + 0.12 * Math.sin(rKm / 310) * Math.sin(rKm / 1170 + 1.3);
  return { alpha: Math.min(1, seg.alpha * rip), rgb: hexRgb(seg.color) };
}

/** RGBA bytes of the 1-D ring texture (`width` texels from the inner to the outer edge), straight (non-premultiplied) alpha. */
export function ringTexture(ring: RingStyle, width = 512): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const r = ring.innerKm + ((i + 0.5) / width) * (ring.outerKm - ring.innerKm);
    const s = ringSample(ring, r);
    out[i * 4] = Math.round(s.rgb[0] * 255);
    out[i * 4 + 1] = Math.round(s.rgb[1] * 255);
    out[i * 4 + 2] = Math.round(s.rgb[2] * 255);
    out[i * 4 + 3] = Math.round(s.alpha * 255);
  }
  return out;
}

/** Disc radius (px) under which a body is also marked with a small glyph, and the glyph's size (px): see `CelestialLayer.updateMarkers`. */
export const MARKER_BELOW_PX = 2.5;
export const MARKER_SIZE_PX = 9;
