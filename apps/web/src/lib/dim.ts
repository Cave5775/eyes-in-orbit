/**
 * How much "dimmed" dims: ONE definition for everything the scene draws dimmed, the points that HIGHLIGHT does not pick
 * (`SceneController.applyAppearance`) and the orbit lines of the selected object's children (`scene/overlays.ts`).
 */
export const DIM = {
  /** factor on the colour of a dimmed point or line */
  colour: 0.3,
  /** factor on the size of a dimmed point */
  size: 0.7,
} as const;

/** A colour channel (or any 0..1 intensity) as drawn dimmed. */
export const dimmed = (v: number): number => v * DIM.colour;
