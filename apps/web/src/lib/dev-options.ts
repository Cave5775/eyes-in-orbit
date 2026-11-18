/**
 * Developer options: a small registry of tuning switches behind the top bar's hidden icon button. Add an option by adding one
 * definition to `DEV_OPTIONS`; the panel, the parsing, the clamping, the defaults and the storage all follow from it.
 * Pure logic (no React, no DOM); the values live in `state/dev-options.ts`.
 */

import { SMOOTH_OPTIONS } from './smoothing';

export interface ToggleOption { id: string; label: string; hint?: string; type: 'toggle'; default: boolean }
export interface NumberOption { id: string; label: string; hint?: string; type: 'number'; min: number; max: number; step: number; unit?: string; default: number }
export type DevOptionDef = ToggleOption | NumberOption;
export type DevValue = boolean | number;
export type DevValues = Record<string, DevValue>;

/** localStorage key: one JSON object holding every option that differs from its default, so there is a single stored format. */
export const DEV_OPTIONS_KEY = 'eio.dev.v1';

/** Every developer option. Features append their definitions here. */
export const DEV_OPTIONS: readonly DevOptionDef[] = [...SMOOTH_OPTIONS];

/** Minimal slice of the Web Storage interface. */
export interface DevStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultStorage(): DevStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** `v` limited to the option's range and snapped to its step (counted from `min`); non-finite input gives the default. */
export function clampNumber(def: NumberOption, v: number): number {
  if (!Number.isFinite(v)) return def.default;
  const clamped = Math.min(def.max, Math.max(def.min, v));
  const snapped = def.min + Math.round((clamped - def.min) / def.step) * def.step;
  // decimal noise from the step arithmetic (0.1 + 0.2) is rounded off at the step's own precision
  const decimals = Math.max(0, Math.ceil(-Math.log10(def.step)) + 1);
  return Math.min(def.max, Math.max(def.min, Number(snapped.toFixed(decimals))));
}

/** A stored or typed value read for `def`: the right type and in range, or the default when it does not fit. */
export function parseValue(def: DevOptionDef, raw: unknown): DevValue {
  if (def.type === 'toggle') return typeof raw === 'boolean' ? raw : def.default;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return clampNumber(def, n);
}

export function defaultValues(defs: readonly DevOptionDef[] = DEV_OPTIONS): DevValues {
  const out: DevValues = {};
  for (const d of defs) out[d.id] = d.default;
  return out;
}

/** The remembered values: unknown ids are dropped, bad or missing ones are the default, blocked storage gives the defaults. */
export function loadDevValues(storage: Pick<DevStorage, 'getItem'> | null | undefined = defaultStorage(), defs: readonly DevOptionDef[] = DEV_OPTIONS): DevValues {
  const out = defaultValues(defs);
  try {
    const text = storage?.getItem(DEV_OPTIONS_KEY);
    if (!text) return out;
    const stored: unknown = JSON.parse(text);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out;
    for (const d of defs) if (d.id in stored) out[d.id] = parseValue(d, (stored as Record<string, unknown>)[d.id]);
  } catch { /* unreadable storage or text: the defaults */ }
  return out;
}

/** Remember only what differs from the default (an empty object when everything is at its default). */
export function saveDevValues(values: DevValues, storage: DevStorage | null | undefined = defaultStorage(), defs: readonly DevOptionDef[] = DEV_OPTIONS): void {
  try {
    const changed: DevValues = {};
    for (const d of defs) if (values[d.id] !== undefined && values[d.id] !== d.default) changed[d.id] = values[d.id];
    storage?.setItem(DEV_OPTIONS_KEY, JSON.stringify(changed));
  } catch { /* private window: the choices just are not remembered */ }
}

export const atDevDefaults = (values: DevValues, defs: readonly DevOptionDef[] = DEV_OPTIONS): boolean => defs.every((d) => values[d.id] === d.default);
