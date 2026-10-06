import type { Drawing } from "../models/drawing";
import type { CadPoint, Entity } from "../models/entity";
import type { Page, PageViewport } from "../models/page";
import { computeViewport, pointToPixel, type Viewport } from "./coordinateMapper";
import { entityBounds } from "./boundsCalculator";
import { projectEntityToPage } from "./viewportMapper";
import { mapLineWeightToPixels } from "../utils/lineWeight";
import { arcFromBulge, arcSpan, clamp, radToDeg, TAU } from "../utils/geometry";
import {
DEFAULT_MAX_TEXT_CAP_PX,
  DEFAULT_MIN_TEXT_CAP_PX,
  MTEXT_LINE_PITCH,
  TEXT_CAP_HEIGHT_RATIO,
  textBlockSize,
  textEntityBounds,
  textHeight,
  textWidthFactor,
} from "./textMetrics";

export interface RenderOptions {
  colorMode: "monochrome" | "color";
  maxWidth: number;
  maxHeight: number;
  margin: number;
  minStrokePx?: number;
  /**
   * Smallest cap height, in output pixels, any label may be drawn at. Defaults to
   * `DEFAULT_MIN_TEXT_CAP_PX`; overridable per render via `MIN_TEXT_CAP_PX`.
   */
  minTextCapPx?: number;
  /**
   * Largest cap height, in output pixels, any label may be drawn at. Defaults to
   * `DEFAULT_MAX_TEXT_CAP_PX`; overridable via `MAX_TEXT_CAP_PX`. Applies in
   * both strict and non-strict modes — see `DEFAULT_MAX_TEXT_CAP_PX` for why a
   * ceiling is needed even once the floor is off.
   */
  maxTextCapPx?: number;
  fontFamily?: string;
  /**
   * Oversample factor for higher-quality anti-aliasing. The SVG is emitted at
   * this many times the target pixel size and then downscaled by the PNG
   * generator; a value of 1 (or undefined) renders at exact size.
   */
  supersample?: number;
  /**
   * Cheap preview mode (picker thumbnails): model content is decimated inside
   * viewports and annotations/points are dropped so the SVG stays small enough
   * for sharp to rasterize quickly.
   */
  lite?: boolean;
  /** If true, do not apply minimum text cap height floor (strict DWG scale). */
  strictTextScale?: boolean;
}

/** Cap on the model entities projected through any one viewport in lite mode. */
const LITE_VIEWPORT_MAX_ENTITIES = 3500;
/**
 * Entity kinds omitted from lite viewport projections. Only POINT: annotation
 * text is what identifies a layout (title blocks, dimension strings, notes), so
 * dropping it left sheets rendering blank in the picker.
 */
const LITE_SKIP_TYPES: ReadonlySet<string> = new Set(["POINT"]);
/**
 * When a lite (thumbnail) drawing's model exceeds this many entities, the model
 * is not projected through the viewports at all — the card shows the sheet
 * frame plus dashed viewport rectangles instead. Keeps the picker grid fast for
 * very large DWGs while still showing each sheet's framing.
 */
const LITE_FAST_PREVIEW_ENTITIES = 12000;
/**
 * Hard ceiling (px) on the longest canvas edge after supersampling. Guards
 * against an enormous supersampled SVG (and the sharp raster buffer that
 * follows) when the requested output dimension or supersample is raised; the
 * supersample is scaled back so the canvas never exceeds this.
 */
const MAX_SUPERSAMPLED_EDGE = 6144;

interface RenderContext {
  viewport: Viewport;
  colorMode: "monochrome" | "color";
  minStrokePx: number;
  fontFamily: string;
  bounds: Drawing["bounds"];
  minTextCapPx: number;
  maxTextCapPx: number;
}

/** Axis-aligned bounding box in model coordinates. */
interface ModelAabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Conservative per-entity bounds in model coordinates, cached per entity array.
 * Every paper-space sheet projects the same model-space array, so the AABBs are
 * computed once and reused across all sheets for viewport-window culling.
 */
const entityBoundsCache = new WeakMap<Entity[], Array<ModelAabb | null>>();

function entityModelBounds(entity: Entity): ModelAabb | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: { x: number; y: number; z?: number }): void => {
    if (Number.isFinite(p.x)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    if (Number.isFinite(p.y)) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  };
  switch (entity.type) {
    case "POLYLINE":
    case "SOLID":
    case "IMAGE":
      for (const v of entity.vertices) {
        add(v);
      }
      break;
    case "LINE":
      add(entity.start);
      add(entity.end);
      break;
    case "CIRCLE":
      add({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
      add({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
      break;
    case "ARC":
      add({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
      add({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
      break;
    case "ELLIPSE": {
      const r = Math.max(1e-9, Math.hypot(entity.majorAxisEndPoint.x ?? 0, entity.majorAxisEndPoint.y ?? 0));
      add({ x: entity.center.x - r, y: entity.center.y - r });
      add({ x: entity.center.x + r, y: entity.center.y + r });
      break;
    }
    case "POINT": {
      add(entity.position);
      break;
    }
    case "TEXT":
    case "MTEXT": {
      // Text must use its real glyph extents, never the anchor point alone:
      // the culler keeps an entity whose box misses the viewport window, and
      // glyphs run away from the anchor for right/centre/bottom alignment,
      // rotation and wrapped MTEXT. An anchor-only box silently deletes every
      // label sitting near a window edge.
      const b = textEntityBounds(entity);
      add({ x: b.minX, y: b.minY });
      add({ x: b.maxX, y: b.maxY });
      break;
    }
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function modelBoundsFor(entities: Entity[]): Array<ModelAabb | null> {
  const cached = entityBoundsCache.get(entities);
  if (cached) {
    return cached;
  }
  const bounds = entities.map(entityModelBounds);
  entityBoundsCache.set(entities, bounds);
  return bounds;
}

function intersectsWindow(b: ModelAabb, x0: number, y0: number, x1: number, y1: number): boolean {
  return b.maxX >= x0 && b.minX <= x1 && b.maxY >= y0 && b.minY <= y1;
}

interface ModelWindowRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bounds: Array<ModelAabb | null>;
}

/**
 * Whether one model entity is actually drawn on this sheet.
 *
 * Mirrors the per-viewport cull in `renderToSvg`: an entity is drawn when some
 * untwisted viewport frames it *and* does not freeze its layer.
 *
 * `pageModelWindow` unions every viewport's window, so on a sheet with two or
 * more viewports it also covers the empty space between them. Scoping text
 * notes by that union listed labels which no viewport frames — they reach the
 * AI brief as if they were on the sheet, while the raster shows nothing. This
 * helper is the per-entity rule the renderer itself applies.
 */
export function entityVisibleOnSheet(page: Page, entity: Entity): boolean {
  const usable = page.viewports.filter(
    (viewport) => viewport.twist === 0 && viewport.viewWidth > 0 && viewport.viewHeight > 0
  );
  // Nothing derivable to cull against: the renderer keeps everything, so this
  // must too.
  if (usable.length === 0) {
    return true;
  }
  const bounds = entityBounds(entity);
  return usable.some((viewport) => {
    if (viewport.frozenLayers.length > 0 && viewport.frozenLayers.includes(entity.layer)) {
      return false;
    }
    const scale = viewport.height / viewport.viewHeight;
    const projectedSpanX = Number.isFinite(scale) && scale > 0 ? viewport.width / scale : viewport.viewWidth;
    const spanX = Math.max(viewport.viewWidth, projectedSpanX);
    const spanY = Math.max(viewport.viewHeight, viewport.height / scale);
    const x0 = viewport.viewCenterX - spanX / 2;
    const y0 = viewport.viewCenterY - spanY / 2;
    const x1 = viewport.viewCenterX + spanX / 2;
    const y1 = viewport.viewCenterY + spanY / 2;
    return intersectsWindow(bounds, x0, y0, x1, y1);
  });
}

/**
 * Conservative model-space window for one viewport, for entity culling.
 *
 * The projection (`viewportMapper`) scales by `height / viewHeight`, so the
 * model span actually shown is `width / scale` horizontally and `viewHeight`
 * vertically. The stored `viewWidth` usually agrees, but whenever it does not
 * the union of both is used — over-culling would delete visible lines, while
 * under-culling only costs SVG size.
 */
function modelWindowRect(
  viewport: PageViewport,
  bounds: Array<ModelAabb | null>
): ModelWindowRect {
  const scale = viewport.height / viewport.viewHeight;
  const projectedSpanX = Number.isFinite(scale) && scale > 0 ? viewport.width / scale : viewport.viewWidth;
  const spanX = Math.max(viewport.viewWidth, projectedSpanX);
  const spanY = Math.max(viewport.viewHeight, viewport.height / scale);
  return {
    x0: viewport.viewCenterX - spanX / 2,
    y0: viewport.viewCenterY - spanY / 2,
    x1: viewport.viewCenterX + spanX / 2,
    y1: viewport.viewCenterY + spanY / 2,
    bounds,
  };
}

/**
 * Conservative union of the model-space area a page's viewports can show.
 *
 * A sheet frames a window onto the model, so its brief should list the labels
 * that sheet actually shows rather than every label in the drawing. Viewports
 * whose window cannot be derived are ignored, matching the cull above; returns
 * null when no viewport yields a usable window, in which case callers must keep
 * everything.
 */
export function pageModelWindow(page: Page): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let any = false;
  for (const viewport of page.viewports) {
    if (viewport.twist !== 0 || !(viewport.viewWidth > 0) || !(viewport.viewHeight > 0)) {
      continue;
    }
    const scale = viewport.height / viewport.viewHeight;
    const projectedSpanX = Number.isFinite(scale) && scale > 0 ? viewport.width / scale : viewport.viewWidth;
    const spanX = Math.max(viewport.viewWidth, projectedSpanX);
    const spanY = Math.max(viewport.viewHeight, viewport.height / scale);
    x0 = Math.min(x0, viewport.viewCenterX - spanX / 2);
    y0 = Math.min(y0, viewport.viewCenterY - spanY / 2);
    x1 = Math.max(x1, viewport.viewCenterX + spanX / 2);
    y1 = Math.max(y1, viewport.viewCenterY + spanY / 2);
    any = true;
  }
  return any ? { x0, y0, x1, y1 } : null;
}

/**
 * Renderer — the only consumer of the normalized Drawing model. Produces a
 * plain SVG in final pixel coordinates (Y inverted, margins applied, monochrome
 * by default). The PNG generator rasterizes this SVG with sharp.
 *
 * When the drawing carries a paper-space page, the sheet is rendered at page
 * proportions and each viewport window shows the model content clipped to it
 * — reproducing what AutoCAD shows at "full page size". Without a page,
 * falls back to fitting the raw model-space bounds.
 */
export function renderToSvg(drawing: Drawing, options: RenderOptions): string {
  if (drawing.page) {
    return renderPageToSvg(drawing, options);
  }
  return renderModelToSvg(drawing, options);
}

function buildContext(bounds: Drawing["bounds"], options: RenderOptions): RenderContext {
  // A non-finite size or margin would make computeViewport return a NaN scale,
  // which propagates into every emitted coordinate and font-size as the literal
  // "NaN". Rasterizers skip those attributes silently, so the sheet would come
  // out with no text and no error. Coerce to usable numbers instead.
  const maxWidth = Number.isFinite(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : 1024;
  const maxHeight = Number.isFinite(options.maxHeight) && options.maxHeight > 0 ? options.maxHeight : 1024;
  const margin = Number.isFinite(options.margin) ? options.margin : 0;
  const viewport = computeViewport(bounds, {
    maxWidth,
    maxHeight,
    margin: Math.max(0, margin),
  });
  return {
    viewport,
    colorMode: options.colorMode,
    minStrokePx: options.minStrokePx ?? 1,
    fontFamily: options.fontFamily ?? getDefaultFont(),
    bounds,
    minTextCapPx:
      options.strictTextScale ?? true
        ? -Infinity
        : Number.isFinite(options.minTextCapPx) && (options.minTextCapPx as number) > 0
          ? (options.minTextCapPx as number)
          : DEFAULT_MIN_TEXT_CAP_PX,
    maxTextCapPx:
      Number.isFinite(options.maxTextCapPx) && (options.maxTextCapPx as number) > 0
        ? (options.maxTextCapPx as number)
        : DEFAULT_MAX_TEXT_CAP_PX,
  };
}

function svgHeader(canvasWidth: number, canvasHeight: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`;
}

/** Requested oversample, scaled back so no canvas edge exceeds the ceiling. */
function resolveSupersample(requested: number, canvasWidth: number, canvasHeight: number): number {
  const longest = Math.max(canvasWidth, canvasHeight);
  if (longest * requested <= MAX_SUPERSAMPLED_EDGE) {
    return requested;
  }
  return Math.max(1, Math.floor(MAX_SUPERSAMPLED_EDGE / Math.max(1, longest)));
}

function backgroundRect(canvasWidth: number, canvasHeight: number): string {
  return `<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="#ffffff"/>`;
}

function renderModelToSvg(drawing: Drawing, options: RenderOptions): string {
  const ctx = buildContext(drawing.bounds, options);
  const supersample = resolveSupersample(options.supersample ?? 1, ctx.viewport.canvasWidth, ctx.viewport.canvasHeight);
  const canvasWidth = ctx.viewport.canvasWidth * supersample;
  const canvasHeight = ctx.viewport.canvasHeight * supersample;

  const parts: string[] = [
    svgHeader(canvasWidth, canvasHeight),
    backgroundRect(canvasWidth, canvasHeight),
    ...(supersample > 1 ? [`<g transform="scale(${supersample})">`] : []),
    "<g>",
  ];
  renderEntities(ctx, drawing.entities, parts);
  parts.push("</g>", ...(supersample > 1 ? ["</g>"] : []), "</svg>");
  return parts.join("\n");
}

function renderPageToSvg(drawing: Drawing, options: RenderOptions): string {
  const page = drawing.page!;
  const ctx = buildContext(page.bounds, options);
  const supersample = resolveSupersample(options.supersample ?? 1, ctx.viewport.canvasWidth, ctx.viewport.canvasHeight);
  const canvasWidth = ctx.viewport.canvasWidth * supersample;
  const canvasHeight = ctx.viewport.canvasHeight * supersample;

  const parts: string[] = [
    svgHeader(canvasWidth, canvasHeight),
    backgroundRect(canvasWidth, canvasHeight),
    ...(supersample > 1 ? [`<g transform="scale(${supersample})">`] : []),
  ];

  // Clip masks for each viewport window (rectangular frames in pixel space).
  page.viewports.forEach((viewport, index) => {
    const topLeft = pointToPixel({ x: viewport.minX, y: viewport.maxY }, page.bounds, ctx.viewport);
    const bottomRight = pointToPixel({ x: viewport.maxX, y: viewport.minY }, page.bounds, ctx.viewport);
    const width = Math.max(0, bottomRight.x - topLeft.x);
    const height = Math.max(0, bottomRight.y - topLeft.y);
    parts.push(
      `<clipPath id="vp-${index}"><rect x="${round(topLeft.x)}" y="${round(topLeft.y)}" width="${round(width)}" height="${round(height)}"/></clipPath>`
    );
  });

  parts.push("<g>");
  // The sheet itself: border, title block, notes — drawn in page coordinates.
  renderEntities(ctx, page.entities, parts);

  // Each viewport window frames the model drawing, clipped to its rect.
  const lite = options.lite ?? false;
  const fastPreview = lite && drawing.entities.length >= LITE_FAST_PREVIEW_ENTITIES;
  const stride =
    lite && drawing.entities.length > LITE_VIEWPORT_MAX_ENTITIES
      ? Math.ceil(drawing.entities.length / LITE_VIEWPORT_MAX_ENTITIES)
      : 1;
  page.viewports.forEach((viewport, index) => {
    if (fastPreview) {
      // Huge models skip the in-window projection: draw the window frame only
      // so the sheet thumbnails stay cheap and still identify the layout.
      const topLeft = pointToPixel({ x: viewport.minX, y: viewport.maxY }, page.bounds, ctx.viewport);
      const bottomRight = pointToPixel({ x: viewport.maxX, y: viewport.minY }, page.bounds, ctx.viewport);
      const width = Math.max(0, bottomRight.x - topLeft.x);
      const height = Math.max(0, bottomRight.y - topLeft.y);
      parts.push(
        `<rect x="${round(topLeft.x)}" y="${round(topLeft.y)}" width="${round(width)}" height="${round(height)}" fill="#ffffff" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3"/>`
      );
      return;
    }
    // Only project model entities whose bounds overlap this viewport's model
    // window: layouts frame a subset in pixel space, and clipping away the
    // rest of a huge model keeps the SVG compact. Rotated (twisted) viewports
    // are excluded to stay conservative.
    //
    // The window must be derived from the same transform the projection uses
    // (scale = height / viewHeight, so spanX = width / scale): trusting the
    // `viewWidth` field alone drops visible geometry whenever its aspect does
    // not match the paper width/height. Take the union of both so the cull can
    // only ever keep too much, never cut something visible.
    const windowRect =
      viewport.twist === 0 && viewport.viewWidth > 0 && viewport.viewHeight > 0
        ? modelWindowRect(viewport, modelBoundsFor(drawing.entities))
        : null;
    parts.push(`<g clip-path="url(#vp-${index})">`);
    const modelInPage: Entity[] = [];
    for (let i = 0; i < drawing.entities.length; i++) {
      if (stride > 1 && i % stride !== 0) {
        continue;
      }
      const entity = drawing.entities[i];
      if (isFrozenInViewport(entity, viewport)) {
        continue;
      }
      if (lite && LITE_SKIP_TYPES.has(entity.type)) {
        continue;
      }
      if (windowRect) {
        const b = windowRect.bounds[i];
        if (b && !intersectsWindow(b, windowRect.x0, windowRect.y0, windowRect.x1, windowRect.y1)) {
          continue;
        }
      }
      modelInPage.push(projectEntityToPage(entity, viewport));
    }
    renderEntities(ctx, modelInPage, parts);
    parts.push("</g>");
  });

  parts.push("</g>", ...(supersample > 1 ? ["</g>"] : []), "</svg>");
  return parts.join("\n");
}

function isFrozenInViewport(entity: Entity, viewport: PageViewport): boolean {
  return viewport.frozenLayers.length > 0 && viewport.frozenLayers.includes(entity.layer);
}

const ENTITY_PASSES: Array<Entity["type"]> = [
  "POLYLINE",
  "LINE",
  "CIRCLE",
  "ARC",
  "ELLIPSE",
  "SOLID",
  "IMAGE",
  "POINT",
  "TEXT",
  "MTEXT",
];

/** Render entities in the established z-order (solid shapes before text). */
function renderEntities(ctx: RenderContext, entities: Entity[], parts: string[]): void {
  for (const pass of ENTITY_PASSES) {
    for (const entity of entities) {
      if (entity.type !== pass) {
        continue;
      }
      parts.push(...renderEntity(ctx, entity));
    }
  }
}

function renderEntity(ctx: RenderContext, entity: Entity): string[] {
  switch (entity.type) {
    case "POLYLINE":
      return renderPolyline(ctx, entity);
    case "LINE":
      return [renderLine(ctx, entity)];
    case "CIRCLE":
      return [renderCircle(ctx, entity)];
    case "ARC":
      return [renderArc(ctx, entity)];
    case "ELLIPSE":
      return [renderEllipse(ctx, entity)];
    case "SOLID":
      return [renderSolid(ctx, entity)];
    case "IMAGE":
      return [renderImage(ctx, entity)];
    case "POINT":
      return [renderPoint(ctx, entity)];
    case "TEXT":
    case "MTEXT":
      return [renderText(ctx, entity)];
  }
}

function strokeColor(ctx: RenderContext, entity: { color: string }): string {
  return ctx.colorMode === "monochrome" ? "#000000" : entity.color;
}

function strokeWidth(ctx: RenderContext, entity: { lineWeight: number }): number {
  return mapLineWeightToPixels(entity.lineWeight, ctx.viewport.scale, ctx.minStrokePx);
}

function px(point: CadPoint, ctx: RenderContext): { x: number; y: number } {
  const p = pointToPixel(point, ctx.bounds, ctx.viewport);
  return { x: round(p.x), y: round(p.y) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Arc ring-step that keeps the chord error close to 0.25 px. */
function arcStep(radiusPx: number): number {
  return clamp(2 * Math.asin(Math.min(1, 0.25 / Math.max(radiusPx, 1e-6))), Math.PI / 720, Math.PI / 45);
}

/** Sample a circular arc (CCW from startAngle over `span`) into world points. */
function sampleCircleArc(
  center: CadPoint,
  radiusWorld: number,
  scale: number,
  startAngle: number,
  span: number
): CadPoint[] {
  const radiusPx = radiusWorld * scale;
  const step = arcStep(radiusPx);
  const count = Math.max(2, Math.min(1440, Math.ceil(span / step)));
  const points: CadPoint[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = startAngle + (span * i) / count;
    points.push({
      x: center.x + radiusWorld * Math.cos(angle),
      y: center.y + radiusWorld * Math.sin(angle),
    });
  }
  return points;
}

function pathFromPoints(points: CadPoint[], ctx: RenderContext, closed: boolean): string {
  if (points.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = px(points[i], ctx);
    parts.push(`${i === 0 ? "M" : "L"} ${p.x} ${p.y}`);
  }
  if (closed && points.length > 2) {
    parts.push("Z");
  }
  return parts.join(" ");
}

function strokePathElement(path: string, color: string, width: number): string {
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/>`;
}

/**
 * Returns the angular span for a bulge segment. Travels through the arc apex:
 * CCW when the apex lies in the CCW sweep from `startAngle`. The apex is the
 * midpoint of the chord displaced by the bulge sagitta.
 */
function bulgeSpan(
  startAngle: number,
  endAngle: number,
  clockwise: boolean
): { start: number; span: number } {
  const ccwSpan = arcSpan(startAngle, endAngle);
  if (clockwise) {
    return { start: endAngle, span: TAU - ccwSpan };
  }
  return { start: startAngle, span: ccwSpan };
}

/**
 * Flatten one polyline (including bulge arcs) into a single ordered point
 * list in world coordinates.
 *
 * A closed polyline must close exactly once, at its own end. Emitting each
 * straight run and each sampled arc as an independent sub-path, and closing
 * *every* one of them, draws a spurious straight chord across each arc of a
 * closed bulged polyline. Keeping one continuous list means the single trailing
 * `Z` only closes the polyline itself.
 */
function polylinePathPoints(entity: Extract<Entity, { type: "POLYLINE" }>): CadPoint[] {
  const points = entity.vertices;
  const bulges = entity.bulges;
  if (points.length === 0) {
    return [];
  }
  const out: CadPoint[] = [points[0]];

  const appendSegment = (from: CadPoint, to: CadPoint, bulge: number): void => {
    if (Math.abs(bulge) < 1e-6) {
      out.push(to);
      return;
    }
    const arc = arcFromBulge(from, to, bulge);
    if (!arc) {
      out.push(to);
      return;
    }
    const { start, span } = bulgeSpan(arc.startAngle, arc.endAngle, arc.clockwise);
    const sampled = sampleCircleArc(arc.center, arc.radius, 1, start, span);
    // The sampled arc starts at `from`, which is already the last point.
    for (let k = 1; k < sampled.length; k++) {
      out.push(sampled[k]);
    }
  };

  for (let i = 0; i < points.length - 1; i++) {
    appendSegment(points[i], points[i + 1], bulges[i] ?? 0);
  }
  if (entity.closed && points.length > 1) {
    appendSegment(points[points.length - 1], points[0], bulges[points.length - 1] ?? 0);
  }
  return out;
}

function renderPolyline(ctx: RenderContext, entity: Extract<Entity, { type: "POLYLINE" }>): string[] {
  const points = polylinePathPoints(entity);
  if (points.length < 2) {
    return [];
  }
  const color = strokeColor(ctx, entity);
  const width = strokeWidth(ctx, entity);
  const path = pathFromPoints(points, ctx, entity.closed && points.length > 2);
  return path ? [strokePathElement(path, color, width)] : [];
}

function renderLine(ctx: RenderContext, entity: Extract<Entity, { type: "LINE" }>): string {
  const a = px(entity.start, ctx);
  const b = px(entity.end, ctx);
  return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}"/>`;
}

function renderCircle(ctx: RenderContext, entity: Extract<Entity, { type: "CIRCLE" }>): string {
  if (!Number.isFinite(entity.radius) || entity.radius <= 0) {
    return "";
  }
  const c = px(entity.center, ctx);
  const r = round(entity.radius * ctx.viewport.scale);
  return `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="none" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}"/>`;
}

function renderArc(ctx: RenderContext, entity: Extract<Entity, { type: "ARC" }>): string {
  if (!Number.isFinite(entity.radius) || entity.radius <= 0) {
    return "";
  }
  const span = arcSpan(entity.startAngle, entity.endAngle);
  const world = sampleCircleArc(
    { x: entity.center.x, y: entity.center.y },
    entity.radius,
    ctx.viewport.scale,
    entity.startAngle,
    span
  );
  return strokePathElement(pathFromPoints(world, ctx, false), strokeColor(ctx, entity), strokeWidth(ctx, entity));
}

function renderEllipse(ctx: RenderContext, entity: Extract<Entity, { type: "ELLIPSE" }>): string {
  const { center, majorAxisEndPoint, radiusRatio, startAngle, endAngle } = entity;
  const majX = majorAxisEndPoint.x;
  const majY = majorAxisEndPoint.y;
  const majorLen = Math.hypot(majX, majY);
  if (majorLen < 1e-9) {
    return "";
  }
  const minorLen = majorLen * radiusRatio;
  const minX = (-majY / majorLen) * minorLen;
  const minY = (majX / majorLen) * minorLen;

  const full = entity.full || Math.abs(arcSpan(startAngle, endAngle) - TAU) < 1e-6;
  const span = full ? TAU : arcSpan(startAngle, endAngle);
  const step = arcStep(majorLen * ctx.viewport.scale);
  const count = Math.max(2, Math.min(1440, Math.ceil(span / step)));

  const world: CadPoint[] = [];
  for (let i = 0; i <= count; i++) {
    const t = startAngle + (span * i) / count;
    world.push({
      x: center.x + majX * Math.cos(t) + minX * Math.sin(t),
      y: center.y + majY * Math.cos(t) + minY * Math.sin(t),
    });
  }
  return strokePathElement(pathFromPoints(world, ctx, full), strokeColor(ctx, entity), strokeWidth(ctx, entity));
}

function renderPoint(ctx: RenderContext, entity: Extract<Entity, { type: "POINT" }>): string {
  const p = px(entity.position, ctx);
  return `<circle cx="${p.x}" cy="${p.y}" r="${Math.max(1.5, ctx.minStrokePx)}" fill="${strokeColor(ctx, entity)}"/>`;
}

/**
 * Opacity used when a filled region is painted in color mode. Low enough that
 * the line work underneath still reads, high enough that the fill is legible
 * as a highlight.
 */
const HIGHLIGHT_FILL_OPACITY = 0.2;

/**
 * Light grey used to fill substantial regions in monochrome mode.
 *
 * Deliberately not `HIGHLIGHT_FILL_OPACITY`-faded black: a faded black fill over
 * dense line work greys the line work itself. A flat light grey paints the
 * region without touching the black strokes on top of it, so the drawing stays
 * crisp and only the filled area separates. `#d4d4d4` is light enough to read
 * text through and dark enough to be unmistakably a fill.
 */
const MONOCHROME_HIGHLIGHT_FILL = "#d4d4d4";

/**
 * Smallest share of the sheet a filled region must cover to count as a highlight.
 *
 * Measured against the drawing's own bounds, not an absolute unit area, so it
 * holds for a 36-unit sheet and a 4000-unit site plan alike. 0.05% of a 3000px
 * sheet is a 21x21px patch: above it a slab, floor finish or marked-up material
 * reads as a highlight; below it only small marks qualify.
 *
 * This threshold is what excludes arrowheads. Dimension and leader arrowheads are
 * `SOLID`s with `filled: true` (see `extractLeader` and the `*D` block entities
 * expanded by `expandDimensionBlock`), but they are tiny — an arrowhead is a
 * fraction of a percent of a sheet. Grey-filling them turned every dimension in
 * the drawing into a grey blob and was the second thing the customer noticed
 * about the oversized text, since they sit right next to it.
 */
const MONOCHROME_HIGHLIGHT_MIN_AREA_FRACTION = 0.0005;

/** Shoelace area of a closed polygon in model units, absolute. */
function polygonArea(vertices: CadPoint[]): number {
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Draw a polygon (SOLID / 3DFACE / expanded solid hatch).
 *
 * **Monochrome fills substantial regions light grey and strokes the outline;
 * color mode also paints the fill in the DWG's own colour.**
 * Reusing the stroke colour as an opaque fill is wrong in monochrome:
 * `strokeColor` returns `#000000` for every entity there, and `resolveColorHex`
 * additionally rewrites near-white to black, so any solid hatch, `Solid` or
 * leader arrowhead filled solid black regardless of the colour the DWG gave it.
 * A single large filled region — a slab, a floor finish, a highlighted material
 * — then painted over a third of the sheet and buried the line work under it.
 *
 * Monochrome therefore fills in `MONOCHROME_HIGHLIGHT_FILL` rather than black, and
 * only above `MONOCHROME_HIGHLIGHT_MIN_AREA_FRACTION` of the sheet, so highlights
 * still read as highlights without greying the drawing. Anything below that
 * threshold is stroke-only, which is what keeps arrowheads black and crisp.
 *
 * In color mode the DWG's own colour is kept, and a region the DWG marks as
 * filled is painted at `HIGHLIGHT_FILL_OPACITY`: that is what makes a highlight
 * (a coloured hatch, a marked-up material) read as a highlight in the PNG
 * instead of collapsing into the surrounding line work. The opacity keeps the
 * line work beneath it visible. `entity.filled` still records the DWG's own fill
 * intent (see `Entity.filled`), so nothing is lost from the model.
 */
function renderSolid(ctx: RenderContext, entity: Extract<Entity, { type: "SOLID" }>): string {
  if (entity.vertices.length < 3) {
    return "";
  }
  const points = entity.vertices.map((v) => px(v, ctx)).map((p) => `${p.x},${p.y}`).join(" ");
  const color = strokeColor(ctx, entity);
  const paint =
    entity.filled &&
    (ctx.colorMode === "color" || isSubstantialFilledRegion(ctx, entity));
  const fill =
    ctx.colorMode === "color" ? (paint ? color : "none") : paint ? MONOCHROME_HIGHLIGHT_FILL : "none";
  const opacity = paint && ctx.colorMode === "color" ? ` fill-opacity="${HIGHLIGHT_FILL_OPACITY}"` : "";
  return `<polygon points="${points}" fill="${fill}"${opacity} stroke="${color}" stroke-width="${strokeWidth(ctx, entity)}" stroke-linejoin="round"/>`;
}

/**
 * Whether a filled region is big enough to read as a highlight rather than as
 * line work. Compares its area against the drawing's own extent so the answer
 * does not depend on the sheet's units; see
 * `MONOCHROME_HIGHLIGHT_MIN_AREA_FRACTION`.
 */
function isSubstantialFilledRegion(ctx: RenderContext, entity: Extract<Entity, { type: "SOLID" }>): boolean {
  const sheetWidth = ctx.bounds.maxX - ctx.bounds.minX;
  const sheetHeight = ctx.bounds.maxY - ctx.bounds.minY;
  const sheetArea = sheetWidth * sheetHeight;
  // A degenerate sheet (a zero-extent span, a single point) has no meaningful
  // area to compare against. Treat the region as substantial so it is not
  // silently dropped — the fill is light and cannot bury the line work.
  if (!Number.isFinite(sheetArea) || sheetArea <= 0) {
    return true;
  }
  return polygonArea(entity.vertices) / sheetArea >= MONOCHROME_HIGHLIGHT_MIN_AREA_FRACTION;
}

/** Light fill for RasterImage placeholder frames (the actual pixels are external to the DWG). */
const IMAGE_PLACEHOLDER_FILL = "#e5e7eb";

function renderImage(ctx: RenderContext, entity: Extract<Entity, { type: "IMAGE" }>): string {
  if (entity.vertices.length < 3) {
    return "";
  }
  const points = entity.vertices
    .map((v) => px(v, ctx))
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
  const width = Math.max(1, ctx.minStrokePx);
  return `<polygon points="${points}" fill="${IMAGE_PLACEHOLDER_FILL}" stroke="${strokeColor(ctx, entity)}" stroke-width="${width}" stroke-linejoin="round"/>`;
}

/**
 * Draw one label at its true DWG size.
 *
 * With `STRICT_TEXT_SCALE` on (the default) `ctx.minTextCapPx` is `-Infinity`,
 * so this is exactly `textHeight(entity) * scale` — a label the source drawing
 * makes 0.4px tall renders 0.4px tall. With it off, the floor applies and small
 * annotations are inflated until they are legible; see `DEFAULT_MIN_TEXT_CAP_PX`
 * in textMetrics for what that trades away.
 *
 * `ctx.maxTextCapPx` bounds the result from above in both modes. Without it the
 * strict path had no limit at all, and `viewport.scale` is unbounded, so a single
 * bad entity height would render a label larger than the sheet.
 */
function renderText(ctx: RenderContext, entity: Extract<Entity, { type: "TEXT" | "MTEXT" }>): string {
  // `textBlockSize` owns line splitting and MTEXT wrapping so the emitted
  // tspans, the entity bounds and the viewport culler all agree on how many
  // lines there are and how wide the block is.
  const block = textBlockSize(entity);
  if (block.lines.length === 0) {
    return "";
  }
  const p = px(entity.position, ctx);
  const capHeightPx = Math.min(
    Math.max(textHeight(entity) * ctx.viewport.scale, ctx.minTextCapPx),
    ctx.maxTextCapPx
  );
  const fontSize = round(capHeightPx / TEXT_CAP_HEIGHT_RATIO);
  const anchor =
    entity.alignment.horizontal === "center" ? "middle" : entity.alignment.horizontal === "right" ? "end" : "start";
  const baseline = round(p.y + baselineShift(entity, fontSize, block.lines.length));
  const dy = round(MTEXT_LINE_PITCH * fontSize);
  const tspans = block.lines
    .map((line, index) => `<tspan x="${p.x}" dy="${index === 0 ? 0 : dy}">${escapeXml(line)}</tspan>`)
    .join("");

  // Transforms are combined in one `transform` attribute: an oblique DWG angle
  // leans the glyphs (skewX about the baseline origin), and a rotated label is
  // turned about its own baseline start so the anchor stays put.
  const transforms: string[] = [];
  if (entity.type === "TEXT" && entity.oblique) {
    transforms.push(`skewX(${round(-radToDeg(entity.oblique) * 100) / 100})`);
  }
  if (entity.rotation) {
    transforms.push(`rotate(${round(-radToDeg(entity.rotation) * 100) / 100} ${p.x} ${baseline})`);
  }
  const transform = transforms.length > 0 ? ` transform="${transforms.join(" ")}"` : "";

  // A DWG widthFactor stretches glyphs horizontally. `textLength` reproduces it
  // from the same metric the bounds use, so the ink fills the reserved box. When
  // the legibility floor inflated the label, that reserved box is still at true
  // model scale, so it is widened by the same ratio: squeezing a 7px label into
  // a 0.11px-wide box would crush the glyphs into an unreadable sliver, which is
  // exactly the failure the floor exists to prevent.
  const widthFactor = textWidthFactor(entity);
  const naturalCapPx = textHeight(entity) * ctx.viewport.scale;
  const inflation = naturalCapPx > 0 ? capHeightPx / naturalCapPx : 1;
  const textLength =
    widthFactor === 1
      ? ""
      : ` textLength="${round(block.width * ctx.viewport.scale * inflation)}" lengthAdjust="spacingAndGlyphs"`;

  return `<text x="${p.x}" y="${baseline}" font-family="${escapeAttr(ctx.fontFamily)}" font-size="${fontSize}" text-anchor="${anchor}" fill="${strokeColor(ctx, entity)}"${textLength}${transform}>${tspans}</text>`;
}

/**
 * Offset from the CAD anchor to the SVG baseline.
 *
 * SVG positions text by its baseline, but a CAD anchor may be the top, middle
 * or bottom of the text box. Pixel Y grows downwards, so those anchors shift
 * the baseline down (top) or up (bottom) from the anchor point. The fractions
 * are the usual cap-height / x-height / descent ratios of a sans-serif face;
 * `dominant-baseline` would be tidier but is not uniformly supported by SVG
 * rasterizers. For multi-line blocks the whole block is shifted so the anchor
 * still refers to the same edge of the block.
 */
function baselineShift(entity: Extract<Entity, { type: "TEXT" | "MTEXT" }>, fontSize: number, lineCount: number): number {
  const blockHeight = (lineCount - 1) * MTEXT_LINE_PITCH * fontSize;
  switch (entity.alignment.vertical) {
    case "top":
      return 0.8 * fontSize;
    case "middle":
      return 0.35 * fontSize - blockHeight / 2;
    case "bottom":
      return -0.2 * fontSize - blockHeight;
    default:
      return 0;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function getDefaultFont(): string {
  return "Segoe UI, Arial, Helvetica, sans-serif";
}