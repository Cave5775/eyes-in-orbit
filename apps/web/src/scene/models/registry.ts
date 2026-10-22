import { ISS_MODEL } from './iss';
import { ROCKET_STAGE_MODEL } from './rocket-stage';
import { SATELLITE_MODEL } from './satellite';
import type { ModelDef } from './types';

/**
 * Model registry: `EntityRecord.render.model` (a string key) -> a procedural three.js builder. To add a model, write a
 * builder returning a `ModelInstance` (see `kit.ts`) and list its `ModelDef` here; nothing else changes.
 */
export const MODELS: Readonly<Record<string, ModelDef>> = {
  [ISS_MODEL.key]: ISS_MODEL,
  [SATELLITE_MODEL.key]: SATELLITE_MODEL,
  [ROCKET_STAGE_MODEL.key]: ROCKET_STAGE_MODEL,
};

/** Definition for a `render.model` key, or undefined (unknown keys, such as a future glb url, draw no model). */
export const modelDef = (key: string | undefined): ModelDef | undefined => (key ? MODELS[key] : undefined);
