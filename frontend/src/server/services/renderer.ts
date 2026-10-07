import type { Drawing } from "../models/drawing";
import type { CadPoint, Entity } from "../models/entity";
import type { Page, PageViewport } from "../models/page";
import { computeViewport, pointToPixel, type Viewport } from "./coordinateMapper";
import { entityBounds } from "./boundsCalculator";
import { projectEntityToPage } from "./viewportMapper";
import { mapLineWeightToPixels } from "../utils/lineWeight";
import { arcFromBulge, arcSpan, radToDeg, TAU } from "../utils/geometry";
import {
  DEFAULT_MAX_TEXT_CAP_PX,
  DEFAULT_MIN_TEXT_CAP_PX,
  MTEXT_LINE_PITCH,
  TEXT_CAP_HEIGHT_RATIO,
  mtextLineSpacing,
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
   * Drawing units per millimetre, from the DWG header. Lets lineweights
   * (stored in mm) convert to plot-accurate pixel widths; defaults to 1
   * (millimetres) when the caller does not supply the document's value.
   */
  unitsPerMm?: number;
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
  unitsPerMm: number;
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
  // `MAX_TEXT_CAP_PX` absent or 0 means auto: the tuned default cap, and in
  // every case a hard guard of the canvas itself so a runaway height can never
  // outgrow the sheet it is drawn on.
  const configuredCap =
    Number.isFinite(options.maxTextCapPx) && (options.maxTextCapPx as number) > 0
      ? (options.maxTextCapPx as number)
      : DEFAULT_MAX_TEXT_CAP_PX;
  return {
    viewport,
    colorMode: options.colorMode,
    minStrokePx: options.minStrokePx ?? 1,
    unitsPerMm: Number.isFinite(options.unitsPerMm) && (options.unitsPerMm as number) > 0 ? (options.unitsPerMm as number) : 1,
    fontFamily: options.fontFamily ?? getDefaultFont(),
    bounds,
    minTextCapPx:
      options.strictTextScale ?? true
        ? -Infinity
        : Number.isFinite(options.minTextCapPx) && (options.minTextCapPx as number) > 0
          ? (options.minTextCapPx as number)
          : DEFAULT_MIN_TEXT_CAP_PX,
    maxTextCapPx: Math.min(configuredCap, Math.max(1, viewport.canvasHeight / 2)),
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

const EMBEDDED_FONT_FAMILY = "Dwg Sans";

function deploymentBaseUrl(): string {
  const url = (process.env.VERCEL_URL ?? "").trim();
  return url ? `https://${url}` : "";
}

function fontFaceStyle(): string {
  const base = deploymentBaseUrl();
  return base
    ? `<style>@font-face{font-family:"${EMBEDDED_FONT_FAMILY}";src:url("${base}/fonts/Roboto-Regular.ttf") format("truetype");}</style>`
    : "";
}

function renderModelToSvg(drawing: Drawing, options: RenderOptions): string {
  const ctx = buildContext(drawing.bounds, options);
  const supersample = resolveSupersample(options.supersample ?? 1, ctx.viewport.canvasWidth, ctx.viewport.canvasHeight);
  const canvasWidth = ctx.viewport.canvasWidth * supersample;
  const canvasHeight = ctx.viewport.canvasHeight * supersample;

  const parts: string[] = [
    svgHeader(canvasWidth, canvasHeight),
    backgroundRect(canvasWidth, canvasHeight),
    fontFaceStyle(),
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
    fontFaceStyle(),
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

/**
 * Plot-accurate pixel width for an entity's lineweight.
 *
 * The DWG stores weight in millimetres; `ctx.unitsPerMm` (from `$INSUNITS`)
 * turns that into drawing units and the viewport scale into pixels, so a
 * 0.25 mm line lands at the same width AutoCAD would plot it at this sheet
 * resolution (~2–3 px on a 3000 px A4) instead of blowing up to a clamp cap.
 */
function strokeWidth(ctx: RenderContext, entity: { lineWeight: number }): number {
  return mapLineWeightToPixels(entity.lineWeight, ctx.unitsPerMm, ctx.viewport.scale, ctx.minStrokePx);
}

/**
 * `stroke-dasharray` for the entity's resolved linetype, in pixels.
 *
 * The DWG pattern is in drawing units, so it scales with the viewport exactly
 * like the geometry it decorates. Two cases are left solid because they cannot
 * be drawn honestly at this scale:
 *
 *  - a whole dash+gap cycle under ~1.5px: sub-pixel dashes alias into noise,
 *    and at a 50% duty cycle the line visibly fades — AutoCAD itself renders
 *    such fine dashes as a solid hairline;
 *  - no dash segment reaching ~0.6px: nothing in the cycle is individually
 *    resolvable, so the pattern would only grey the line out.
 *
 * An over-long dash (a huge LTSCALE) needs no special case: a dash wider than
 * the canvas simply draws solid, which is also what AutoCAD shows.
 *
 * Empty string for Continuous / unresolved linetypes.
 */
function strokeDash(ctx: RenderContext, entity: { dashPattern?: number[] }): string {
  const pattern = entity.dashPattern;
  if (!pattern || pattern.length < 2) {
    return "";
  }
  const lengths = pattern.map((length) => round(Math.max(length * ctx.viewport.scale, 0.25)));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total < 1.5 || Math.max(...lengths) < 0.6) {
    return "";
  }
  return ` stroke-dasharray="${lengths.join(" ")}"`;
}

function px(point: CadPoint, ctx: RenderContext): { x: number; y: number } {
  const p = pointToPixel(point, ctx.bounds, ctx.viewport);
  return { x: round(p.x), y: round(p.y) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * `A` arc command for a pixel-space start point, given the arc's angular span
 * in world space.
 *
 * The Y axis is inverted between world and pixel space, which turns a world
 * CCW sweep (positive direction in DWG space) into sweep-flag 0. The large-arc
 * flag is one exactly when the sweep covers more than a half turn.
 */
function arcCommand(
  rxPx: number,
  ryPx: number,
  rotDeg: number,
  span: number,
  sweep: 0 | 1,
  end: CadPoint
): string {
  const large = span > Math.PI ? 1 : 0;
  return `A ${rxPx} ${ryPx} ${rotDeg} ${large} ${sweep} ${end.x} ${end.y}`;
}

/** True when two pixel points coincide after rounding. */
function samePixel(a: CadPoint, b: CadPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Path `d` for a world-space circular arc drawn with SVG's native arc command.
 *
 * Curves are no longer polygon-sampled: the old sampling was bounded to a
 * 0.25px chord error per segment (up to 1440 segments per arc, and visible as
 * chunky facets on large radii), whereas the native command draws the exact
 * ellipse. A sweep of a full turn would give SVG coincident endpoints — an
 * arc with no end draws nothing — so full circles are split into two halves,
 * which also covers arcs whose rounded endpoints collide.
 */
function circleArcPathD(
  center: CadPoint,
  radiusWorld: number,
  startAngle: number,
  span: number,
  ctx: RenderContext
): string {
  const r = round(radiusWorld * ctx.viewport.scale);
  const at = (angle: number): CadPoint =>
    px(
      { x: center.x + radiusWorld * Math.cos(angle), y: center.y + radiusWorld * Math.sin(angle) },
      ctx
    );
  const start = at(startAngle);
  const end = at(startAngle + span);
  if (span >= TAU - 1e-9 || samePixel(start, end)) {
    const mid = at(startAngle + span / 2);
    return `M ${start.x} ${start.y} ${arcCommand(r, r, 0, span / 2, 0, mid)} ${arcCommand(r, r, 0, span / 2, 0, start)}`;
  }
  return `M ${start.x} ${start.y} ${arcCommand(r, r, 0, span, 0, end)}`;
}

function strokePathElement(path: string, color: string, width: number, dash = ""): string {
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"${dash}/>`;
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
 * Path `d` for a polyline in pixel space, with bulge arcs as native SVG arcs.
 *
 * One continuous sub-path: a closed polyline must close exactly once, at its
 * own end. Emitting each straight run and each arc as an independent sub-path
 * and closing *every* one of them draws a spurious straight chord across each
 * arc of a closed bulged polyline. Bulge arcs go through `arcFromBulge` —
 * still geometry, no longer a sampled approximation — so an arc is one `A`
 * command instead of up to 1440 `L` segments, and the arc's dash pattern
 * measures against true arc length rather than the chorded one.
 */
function polylinePathD(entity: Extract<Entity, { type: "POLYLINE" }>, ctx: RenderContext): string {
  const points = entity.vertices;
  const bulges = entity.bulges;
  if (points.length === 0) {
    return "";
  }
  const parts: string[] = [];
  const moveTo = (p: CadPoint): void => {
    const q = px(p, ctx);
    parts.push(`M ${q.x} ${q.y}`);
  };
  const lineTo = (p: CadPoint): void => {
    const q = px(p, ctx);
    parts.push(`L ${q.x} ${q.y}`);
  };
  const arcTo = (from: CadPoint, to: CadPoint, bulge: number): void => {
    const arc = arcFromBulge(from, to, bulge);
    if (!arc) {
      lineTo(to);
      return;
    }
    const { start, span } = bulgeSpan(arc.startAngle, arc.endAngle, arc.clockwise);
    const r = round(arc.radius * ctx.viewport.scale);
    const end = px(to, ctx);
    const sweep: 0 | 1 = arc.clockwise ? 1 : 0;
    if (span >= TAU - 1e-9 || samePixel(px(from, ctx), end)) {
      const mid = px(
        {
          x: arc.center.x + arc.radius * Math.cos(start + span / 2),
          y: arc.center.y + arc.radius * Math.sin(start + span / 2),
        },
        ctx
      );
      parts.push(arcCommand(r, r, 0, span / 2, sweep, mid));
      parts.push(arcCommand(r, r, 0, span / 2, sweep, end));
      return;
    }
    parts.push(arcCommand(r, r, 0, span, sweep, end));
  };

  moveTo(points[0]);
  for (let i = 0; i < points.length - 1; i++) {
    const bulge = bulges[i] ?? 0;
    if (Math.abs(bulge) < 1e-6) {
      lineTo(points[i + 1]);
    } else {
      arcTo(points[i], points[i + 1], bulge);
    }
  }
  if (entity.closed && points.length > 1) {
    const last = points[points.length - 1];
    const bulge = bulges[points.length - 1] ?? 0;
    if (Math.abs(bulge) < 1e-6) {
      lineTo(points[0]);
    } else {
      arcTo(last, points[0], bulge);
    }
    if (points.length > 2) {
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

function renderPolyline(ctx: RenderContext, entity: Extract<Entity, { type: "POLYLINE" }>): string[] {
  const path = polylinePathD(entity, ctx);
  if (!path) {
    return [];
  }
  return [strokePathElement(path, strokeColor(ctx, entity), strokeWidth(ctx, entity), strokeDash(ctx, entity))];
}

function renderLine(ctx: RenderContext, entity: Extract<Entity, { type: "LINE" }>): string {
  const a = px(entity.start, ctx);
  const b = px(entity.end, ctx);
  return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}"${strokeDash(ctx, entity)}/>`;
}

function renderCircle(ctx: RenderContext, entity: Extract<Entity, { type: "CIRCLE" }>): string {
  if (!Number.isFinite(entity.radius) || entity.radius <= 0) {
    return "";
  }
  const c = px(entity.center, ctx);
  const r = round(entity.radius * ctx.viewport.scale);
  return `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="none" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}"${strokeDash(ctx, entity)}/>`;
}

function renderArc(ctx: RenderContext, entity: Extract<Entity, { type: "ARC" }>): string {
  if (!Number.isFinite(entity.radius) || entity.radius <= 0) {
    return "";
  }
  const span = arcSpan(entity.startAngle, entity.endAngle);
  const path = circleArcPathD(
    { x: entity.center.x, y: entity.center.y },
    entity.radius,
    entity.startAngle,
    span,
    ctx
  );
  return strokePathElement(path, strokeColor(ctx, entity), strokeWidth(ctx, entity), strokeDash(ctx, entity));
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

  const rx = round(majorLen * ctx.viewport.scale);
  const ry = round(Math.abs(minorLen) * ctx.viewport.scale);
  // SVG measures x-axis-rotation in the coordinate system it is rendered in:
  // pixel space has Y down, so the major axis angle is the negation of the
  // world-space one.
  const rot = round(-radToDeg(Math.atan2(majY, majX)));
  const at = (t: number): CadPoint =>
    px(
      {
        x: center.x + majX * Math.cos(t) + minX * Math.sin(t),
        y: center.y + majY * Math.cos(t) + minY * Math.sin(t),
      },
      ctx
    );

  const full = entity.full || Math.abs(arcSpan(startAngle, endAngle) - TAU) < 1e-6;
  const span = full ? TAU : arcSpan(startAngle, endAngle);
  const start = at(startAngle);
  const end = at(startAngle + span);
  let path: string;
  if (full || samePixel(start, end)) {
    const mid = at(startAngle + span / 2);
    path = `M ${start.x} ${start.y} ${arcCommand(rx, ry, rot, span / 2, 0, mid)} ${arcCommand(rx, ry, rot, span / 2, 0, start)}`;
  } else {
    path = `M ${start.x} ${start.y} ${arcCommand(rx, ry, rot, span, 0, end)}`;
  }
  return strokePathElement(path, strokeColor(ctx, entity), strokeWidth(ctx, entity), strokeDash(ctx, entity));
}

function renderPoint(ctx: RenderContext, entity: Extract<Entity, { type: "POINT" }>): string {
  const p = px(entity.position, ctx);
  return `<circle cx="${p.x}" cy="${p.y}" r="${Math.max(1.5, ctx.minStrokePx)}" fill="${strokeColor(ctx, entity)}"/>`;
}

/**
 * Draw a polygon (SOLID / 3DFACE / expanded solid hatch).
 *
 * **Colour mode paints the fill opaquely in the DWG's own colour** — that is
 * what the source drawing specifies, so a solid hatch, a filled region or a
 * leader arrowhead lands on the PNG exactly as AutoCAD fills it.
 *
 * **Monochrome renders line work only**: the outline is stroked and nothing is
 * filled. Reusing the stroke colour as an opaque fill would paint `#000000`
 * over the line work and bury it (a light-grey "highlight" fill used to sit
 * between the two; it was removed once colour rendering became the product).
 */
function renderSolid(ctx: RenderContext, entity: Extract<Entity, { type: "SOLID" }>): string {
  if (entity.vertices.length < 3) {
    return "";
  }
  const points = entity.vertices.map((v) => px(v, ctx)).map((p) => `${p.x},${p.y}`).join(" ");
  const color = strokeColor(ctx, entity);
  const fill = ctx.colorMode === "color" && entity.filled ? color : "none";
  return `<polygon points="${points}" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth(ctx, entity)}" stroke-linejoin="round"${strokeDash(ctx, entity)}/>`;
}

/**
 * Frame for a RasterImage placeholder (the image's pixels are external to the
 * DWG, so only the placement quadrilateral can be drawn).
 *
 * Outline only, in the entity's own colour — no fill. A light-grey fill here
 * was the last grey box on a colour sheet: with the drawing's real colours in
 * use, a grey patch over the paper reads as a stray highlight rather than as
 * an image.
 */
function renderImage(ctx: RenderContext, entity: Extract<Entity, { type: "IMAGE" }>): string {
  if (entity.vertices.length < 3) {
    return "";
  }
  const points = entity.vertices
    .map((v) => px(v, ctx))
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
  return `<polygon points="${points}" fill="none" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}" stroke-linejoin="round"/>`;
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
  const spacing = mtextLineSpacing(entity);
  const dy = round(MTEXT_LINE_PITCH * spacing * fontSize);
  // An interior blank line is a real row: it is inked as a non-breaking space
  // so the `dy` advance applies — an empty tspan emits no text and some
  // rasterizers then skip its offset, collapsing the rows below it.
  const tspans = block.lines
    .map((line, index) => {
      const ink = line.length > 0 ? escapeXml(line) : "\u00a0";
      return `<tspan x="${p.x}" dy="${index === 0 ? 0 : dy}">${ink}</tspan>`;
    })
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

  // The DWG's own face: a style mapped to Arial Narrow or a bold face renders
  // as that family, falling back to the deployment default when the style is a
  // SHX stroke font or an unmapped name. `xml:space` keeps the leading and
  // interior whitespace the drawing's indentation depends on — SVG collapses
  // it otherwise.
  const family = entity.fontFamily
    ? `${escapeAttr(entity.fontFamily)}, ${ctx.fontFamily}`
    : escapeAttr(ctx.fontFamily);
  const weight = entity.fontBold ? ' font-weight="700"' : "";
  const italic = entity.fontItalic ? ' font-style="italic"' : "";
  return `<text x="${p.x}" y="${baseline}" font-family="${family}" font-size="${fontSize}" text-anchor="${anchor}" fill="${strokeColor(ctx, entity)}"${weight}${italic} xml:space="preserve"${textLength}${transform}>${tspans}</text>`;
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
  const blockHeight = (lineCount - 1) * MTEXT_LINE_PITCH * mtextLineSpacing(entity) * fontSize;
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
  return deploymentBaseUrl()
    ? `${EMBEDDED_FONT_FAMILY}, Segoe UI, Arial, Helvetica, sans-serif`
    : "Segoe UI, Arial, Helvetica, sans-serif";
}