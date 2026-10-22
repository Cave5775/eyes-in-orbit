import type * as THREE from 'three';

/** Everything a model needs to pose its articulated parts for one frame. */
export interface ModelUpdate {
  /** unit vector toward the Sun in the model body frame (+X forward, +Y starboard, +Z nadir) */
  sunBody: [number, number, number];
  /** joint angles in radians by name (see each model's `joints`); parts without an entry keep their last pose */
  joints?: Readonly<Record<string, number>>;
}

/**
 * A built model. Geometry is authored in METRES in the body frame (+X forward, +Y starboard, +Z nadir); the layer scales
 * it to kilometres, positions it camera-relative (floating origin) and orients it from the entity's state.
 */
export interface ModelInstance {
  readonly root: THREE.Group;
  /** names accepted in `ModelUpdate.joints` */
  readonly joints: readonly string[];
  update(u: ModelUpdate): void;
  /** darken for filter-dimmed entities */
  setDim(dim: boolean): void;
  dispose(): void;
}

/** How the model is oriented from the entity's state. */
export type AttitudeMode =
  /** flight attitude: x along the velocity, z nadir (stations, satellites) */
  | 'lvlh'
  /** nose along the Earth-relative velocity, up on the pad or while landing (rocket stages) */
  | 'rocket';

export interface ModelDef {
  key: string;
  label: string;
  /** bounding radius, metres */
  radiusM: number;
  /** the model is drawn when the camera is nearer than this to the entity, km */
  lodKm: number;
  /** a followed entity of this model may be approached down to this distance, km */
  minViewKm: number;
  /** camera distance used by FIT on the entity alone, km */
  fitKm: number;
  attitude: AttitudeMode;
  build(): ModelInstance;
}
