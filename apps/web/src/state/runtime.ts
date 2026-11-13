import { Clock, EntityGraph, type EntityRecord } from '@eio/core';

/** Shared simulation clock: live / paused / scrubbed. Everything evaluates providers at `clock.now()`. */
export const clock = new Clock();

/**
 * Main-thread providers for non-SGP4 entities (and the selected SGP4 entity).
 * Bulk SGP4 propagation lives in the worker, so the catalog is not mirrored here.
 */
export const graph = new EntityGraph();

/**
 * Optional hooks other modules can call without importing the scene. `SceneView` sets `onFitRequest` while it is
 * mounted: it frames the given entity ids (bounding sphere, smooth fly-to, leaves follow mode).
 * Use `runtime.onFitRequest?.(ids)`, e.g. from a launch-group filter that wants to show all of its objects.
 */
export const runtime: { onFitRequest?: (ids: string[]) => void; camera?: CameraCommands } = {};

/**
 * Camera commands the panels can call while the scene is mounted (`runtime.camera?.fitSelected()`): `SceneView` sets the object
 * in its mount effect and clears it on unmount. The hotkeys (F, Shift+F, S) call the same functions.
 */
export interface CameraCommands {
  /** frame the selection, the objects related to it and its drawn path (F) */
  fitSelected(): void;
  /** frame everything visible, respecting the search and the hidden groups (Shift+F) */
  fitVisible(): void;
  /** surface-aligned camera on / off (S); the controller remembers the choice */
  toggleSurface(): void;
  /** fly to the selected object's 3D model and follow it */
  viewModel(id: string): void;
  /** first-person view: stand the camera at the observatory `id` and look outward (Esc and `leaveFirstPerson` leave it) */
  lookFrom(id: string): void;
  /** leave the first-person view only (Esc and the Leave button): the globe view you had comes back, the selection stays */
  leaveFirstPerson(): void;
}

/** Make sure the record has a live provider on the main thread (the scene does this too; panels must not race it). */
export function ensureInGraph(rec: EntityRecord): void {
  if (graph.get(rec.id) !== rec) graph.upsert(rec);
}
