import type { Bounds } from "../models/bounds";
import { boundsWidth, boundsHeight } from "../models/bounds";
import type { CadPoint } from "../models/entity";

export interface ViewportOptions {
  maxWidth: number;
  maxHeight: number;
  /** Base space reserved on every side of the image, in pixels. */
  margin: number;
}

export interface Viewport {
  scale: number;
  canvasWidth: number;
  canvasHeight: number;
  availableWidth: number;
  availableHeight: number;
  margin: number;
  /** Pixel origin of the drawing content (margin + centering offset). */
  offsetX: number;
  offsetY: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * Fit the drawing bounds into a canvas that adopts the drawing's own aspect
 * ratio (so a wide drawing yields a wide output and a tall drawing a tall
 * output, instead of being letterboxed into a fixed square). The width and
 * height caps are independent and `margin` px is reserved on every side; the
 * drawing is scaled uniformly and never cropped or padded into a different
 * proportion.
 */
export function computeViewport(bounds: Bounds, options: ViewportOptions): Viewport {
  const drawingWidth = boundsWidth(bounds);
  const drawingHeight = boundsHeight(bounds);

  // A dimension of zero (e.g. a point or a flat line) must not produce an
  // infinite/unusable scale; treat it as a unit span.
  const spanX = drawingWidth === 0 ? 1 : drawingWidth;
  const spanY = drawingHeight === 0 ? 1 : drawingHeight;

  const margin = Math.max(0, options.margin);
  const innerW = Math.max(1, options.maxWidth - margin * 2);
  const innerH = Math.max(1, options.maxHeight - margin * 2);
  const scale = Math.min(innerW / spanX, innerH / spanY);

  const naturalWidth = spanX * scale;
  const naturalHeight = spanY * scale;

  const offsetX = margin;
  const offsetY = margin;

  const canvasWidth = Math.max(1, Math.ceil(naturalWidth + margin * 2));
  const canvasHeight = Math.max(1, Math.ceil(naturalHeight + margin * 2));

  return {
    scale,
    canvasWidth,
    canvasHeight,
    availableWidth: naturalWidth,
    availableHeight: naturalHeight,
    margin,
    offsetX,
    offsetY,
  };
}

/**
 * Convert a model/world coordinate into image pixel coordinates.
 * The Y axis is inverted: CAD +Y (up) becomes smaller pixel Y (towards the top).
 */
export function worldToPixel(
  x: number,
  y: number,
  bounds: Bounds,
  viewport: Viewport
): PixelPoint {
  const px = viewport.offsetX + (x - bounds.minX) * viewport.scale;
  const py = viewport.offsetY + (bounds.maxY - y) * viewport.scale;
  return { x: px, y: py };
}

export function pointToPixel(point: CadPoint, bounds: Bounds, viewport: Viewport): PixelPoint {
  return worldToPixel(point.x, point.y, bounds, viewport);
}