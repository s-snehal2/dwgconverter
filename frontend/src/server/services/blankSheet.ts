import { entityBounds } from "./boundsCalculator";
import { modelToPagePoint } from "./viewportMapper";
import type { OmittedSheet } from "../../types/conversion";
import type { Entity } from "../models/entity";
import { isUsableViewHeight, type PageViewport } from "../models/page";
import type { InspectedView } from "./convertDwg";

/**
 * "Does this sheet actually show a drawing?" — the semantic counterpart to the
 * ink-coverage test in `convertDwg`.
 *
 * A paper-space layout renders two independent things: the page's own entities
 * (border, title block, notes) and model geometry projected through its
 * viewport windows. A layout whose viewport frames empty model space therefore
 * still produces a *page* full of title-block ink, which is exactly why an
 * ink-coverage test alone lets a visually blank sheet through. Ink says "the
 * page is busy"; this asks the question that actually matters — "is there
 * anything drawn inside the window".
 *
 * The check is pure geometry over already-parsed data, so it costs no rendering
 * and rejects sheets before any pixels are produced.
 */

/**
 * Entity types that count as a drawing. `TEXT`/`MTEXT` are excluded because a
 * sheet carrying only a stray note reads as blank to a person, and `POINT`
 * because a lone point renders as a sub-pixel dot. The set is exported so the
 * definition is one edit away if a workflow needs a different line.
 */
export const DRAWING_ENTITY_TYPES: ReadonlySet<Entity["type"]> = new Set([
  "LINE",
  "CIRCLE",
  "ARC",
  "ELLIPSE",
  "POLYLINE",
  "SOLID",
  "IMAGE",
]);

export function isDrawingEntity(entity: Entity): boolean {
  return DRAWING_ENTITY_TYPES.has(entity.type);
}

/**
 * `OmittedSheet`/`BlankSheetReason` live in the shared API types so the client
 * note and the server filter can never drift; they are re-exported here as the
 * server-side import site.
 */
export type { BlankSheetReason, OmittedSheet } from "../../types/conversion";

function frozenLayerSet(viewport: PageViewport): ReadonlySet<string> {
  return new Set(viewport.frozenLayers);
}

/**
 * The model-space region a viewport shows, inflated to a rectangle in *model*
 * coordinates. Used only as a cheap prefilter: a viewport may be twisted, so
 * the true test projects entity bounds corners through `modelToPagePoint`
 * instead. Inflating by the window diagonal keeps the prefilter conservative
 * for any twist, so it can only ever fail to reject a candidate — never wrongly
 * reject a visible entity.
 */
function modelWindowFor(vp: PageViewport): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const scale = isUsableViewHeight(vp.viewHeight) ? vp.height / vp.viewHeight : 1;
  // Model units spanned by the viewport rect on the page.
  const spanX = vp.width / scale;
  const spanY = vp.height / scale;
  // Generous inflation: half the diagonal covers the largest displacement a
  // rotated window can introduce for entities near the window edge.
  const pad = Math.hypot(spanX, spanY) / 2;
  return {
    minX: vp.viewCenterX - spanX / 2 - pad,
    minY: vp.viewCenterY - spanY / 2 - pad,
    maxX: vp.viewCenterX + spanX / 2 + pad,
    maxY: vp.viewCenterY + spanY / 2 + pad,
  };
}

function overlaps(a: { minX: number; minY: number; maxX: number; maxY: number }, b: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * AABB of an entity's bounds after projecting all four corners through a
 * viewport. Over-approximates for a twisted viewport, which errs toward
 * keeping a sheet — a false keep leaves a blank page, a false drop would lose
 * a real drawing.
 */
function projectedBoundsInPage(entity: Entity, vp: PageViewport) {
  const bounds = entityBounds(entity);
  const corners = [
    [bounds.minX, bounds.minY],
    [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const projected = modelToPagePoint(vp, x, y);
    if (projected.x < minX) minX = projected.x;
    if (projected.x > maxX) maxX = projected.x;
    if (projected.y < minY) minY = projected.y;
    if (projected.y > maxY) maxY = projected.y;
  }
  return { minX, minY, maxX, maxY };
}

function viewportShowsDrawing(vp: PageViewport, modelEntities: Entity[]): boolean {
  const frozen = frozenLayerSet(vp);
  const window = modelWindowFor(vp);
  const pageRect = { minX: vp.minX, minY: vp.minY, maxX: vp.maxX, maxY: vp.maxY };
  for (const entity of modelEntities) {
    if (!isDrawingEntity(entity)) continue;
    if (frozen.has(entity.layer)) continue;
    if (!overlaps(entityBounds(entity), window)) continue;
    if (overlaps(projectedBoundsInPage(entity, vp), pageRect)) return true;
  }
  return false;
}

/**
 * True when a sheet shows no drawing at all and should not become a PNG.
 *
 * Layouts: blank when they have no usable viewport, or when no model geometry
 * lands inside any of their viewports. Model crops: blank when the crop holds
 * nothing but text and points.
 */
export function hasSheetDrawing(view: InspectedView, modelEntities: Entity[]): boolean {
  if (view.isModel) {
    return view.drawing.entities.some(isDrawingEntity);
  }
  const viewports = view.drawing.page?.viewports ?? [];
  if (viewports.length === 0) {
    return false;
  }
  return viewports.some((vp) => viewportShowsDrawing(vp, modelEntities));
}

/**
 * Split selected views into the sheets worth rendering and the ones to omit,
 * preserving draw order. Pure filtering — no rendering, no mutation.
 */
export function partitionRenderable(
  views: InspectedView[],
  modelEntities: Entity[]
): { renderable: InspectedView[]; omitted: OmittedSheet[] } {
  const renderable: InspectedView[] = [];
  const omitted: OmittedSheet[] = [];
  for (const view of views) {
    if (hasSheetDrawing(view, modelEntities)) {
      renderable.push(view);
    } else {
      omitted.push({ name: view.name, reason: "no-drawing" });
    }
  }
  return { renderable, omitted };
}
