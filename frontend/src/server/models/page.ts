import type { Bounds } from "./bounds";
import type { Entity } from "./entity";

/**
 * A rectangular window from a paper-space (layout) viewport onto the model
 * space. Everything is in drawing units: `minX..maxY` is the viewport rect on
 * the page, `viewCenterX..viewHeight` the model-space region it shows.
 */
export interface PageViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  viewCenterX: number;
  viewCenterY: number;
  viewWidth: number;
  viewHeight: number;
  /** View rotation, radians (0 for the overwhelming majority of layouts). */
  twist: number;
  /** Model layers hidden in this viewport (rendered as blank). */
  frozenLayers: string[];
}

/**
 * The DWG's paper-space page (the layout AutoCAD shows at "full page size"):
 * the border/title-block entities in paper coordinates plus the viewport
 * windows that frame the model-space drawing.
 */
export interface Page {
  entities: Entity[];
  viewports: PageViewport[];
  bounds: Bounds;
}

/**
 * Floor for a usable `PageViewport.viewHeight`, in drawing units.
 *
 * CAD units span many orders of magnitude, so this sits far below any real
 * window while still excluding zero, negatives and denormal garbage.
 */
export const MIN_VIEW_HEIGHT = 1e-9;

/**
 * Whether a viewport's model-space window height can produce a usable scale.
 *
 * The page scale is `height / viewHeight`, so a vanishingly small or non-finite
 * denominator would project the entire model to astronomically large pixel
 * coordinates instead of failing cleanly.
 */
export function isUsableViewHeight(viewHeight: number): boolean {
  return Number.isFinite(viewHeight) && viewHeight > MIN_VIEW_HEIGHT;
}