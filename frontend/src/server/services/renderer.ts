import type { Drawing } from "../models/drawing";
import type { CadPoint, Entity } from "../models/entity";
import type { PageViewport } from "../models/page";
import { computeViewport, pointToPixel, type Viewport } from "./coordinateMapper";
import { projectEntityToPage } from "./viewportMapper";
import { mapLineWeightToPixels } from "../utils/lineWeight";
import { arcFromBulge, arcSpan, clamp, radToDeg, TAU } from "../utils/geometry";

export interface RenderOptions {
  colorMode: "monochrome" | "color";
  maxWidth: number;
  maxHeight: number;
  margin: number;
  minStrokePx?: number;
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
}

/** Cap on the model entities projected through any one viewport in lite mode. */
const LITE_VIEWPORT_MAX_ENTITIES = 3500;
/** Entity kinds omitted from lite viewport projections (annotation clutter). */
const LITE_SKIP_TYPES: ReadonlySet<string> = new Set(["TEXT", "MTEXT", "POINT"]);
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
    case "POINT":
    case "TEXT":
    case "MTEXT":
      add(entity.position);
      break;
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
  const viewport = computeViewport(bounds, {
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    margin: options.margin,
  });
  return {
    viewport,
    colorMode: options.colorMode,
    minStrokePx: options.minStrokePx ?? 1,
    fontFamily: options.fontFamily ?? getDefaultFont(),
    bounds,
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
    const windowRect =
      viewport.twist === 0 && viewport.viewWidth > 0 && viewport.viewHeight > 0
        ? {
            x0: viewport.viewCenterX - viewport.viewWidth / 2,
            y0: viewport.viewCenterY - viewport.viewHeight / 2,
            x1: viewport.viewCenterX + viewport.viewWidth / 2,
            y1: viewport.viewCenterY + viewport.viewHeight / 2,
            bounds: modelBoundsFor(drawing.entities),
          }
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

function polylineSegments(entity: Extract<Entity, { type: "POLYLINE" }>): CadPoint[][] {
  const points = entity.vertices;
  const bulges = entity.bulges;
  if (points.length === 0) {
    return [];
  }
  const segments: CadPoint[][] = [];
  let straight: CadPoint[] = [points[0]];

  const flush = () => {
    if (straight.length > 0) {
      segments.push(straight);
      straight = [];
    }
  };

  const appendSegment = (i: number, to: CadPoint) => {
    const bulge = bulges[i] ?? 0;
    if (Math.abs(bulge) < 1e-6 || straight.length === 0) {
      straight.push(to);
      return;
    }
    const from = straight[straight.length - 1];
    const arc = arcFromBulge(from, to, bulge);
    if (!arc) {
      straight.push(to);
      return;
    }
    straight.pop();
    flush();
    const { start, span } = bulgeSpan(arc.startAngle, arc.endAngle, arc.clockwise);
    segments.push(sampleCircleArc(arc.center, arc.radius, 1, start, span));
    straight = [to];
  };

  for (let i = 0; i < points.length - 1; i++) {
    appendSegment(i, points[i + 1]);
  }
  if (entity.closed && points.length > 1) {
    appendSegment(points.length - 1, points[0]);
  } else if (straight.length > 0) {
    flush();
  } else {
    flush();
  }
  return segments.filter((s) => s.length > 0);
}

function renderPolyline(ctx: RenderContext, entity: Extract<Entity, { type: "POLYLINE" }>): string[] {
  const color = strokeColor(ctx, entity);
  const width = strokeWidth(ctx, entity);
  const closed = entity.closed;
  return polylineSegments(entity)
    .map((segment) => strokePathElement(pathFromPoints(segment, ctx, closed && segment.length > 2), color, width))
    .filter(Boolean);
}

function renderLine(ctx: RenderContext, entity: Extract<Entity, { type: "LINE" }>): string {
  const a = px(entity.start, ctx);
  const b = px(entity.end, ctx);
  return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}"/>`;
}

function renderCircle(ctx: RenderContext, entity: Extract<Entity, { type: "CIRCLE" }>): string {
  const c = px(entity.center, ctx);
  const r = round(entity.radius * ctx.viewport.scale);
  return `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="none" stroke="${strokeColor(ctx, entity)}" stroke-width="${strokeWidth(ctx, entity)}"/>`;
}

function renderArc(ctx: RenderContext, entity: Extract<Entity, { type: "ARC" }>): string {
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

function renderSolid(ctx: RenderContext, entity: Extract<Entity, { type: "SOLID" }>): string {
  if (entity.vertices.length < 3) {
    return "";
  }
  const points = entity.vertices.map((v) => px(v, ctx)).map((p) => `${p.x},${p.y}`).join(" ");
  const color = strokeColor(ctx, entity);
  const fill = entity.filled ? color : "none";
  return `<polygon points="${points}" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth(ctx, entity)}" stroke-linejoin="round"/>`;
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

function renderText(ctx: RenderContext, entity: Extract<Entity, { type: "TEXT" | "MTEXT" }>): string {
  const p = px(entity.position, ctx);
  const fontSize = Math.max(entity.height * ctx.viewport.scale, 4);
  const rotationDeg = Math.round(-radToDeg(entity.rotation) * 100) / 100;
  const anchor =
    entity.alignment.horizontal === "center" ? "middle" : entity.alignment.horizontal === "right" ? "end" : "start";
  const text = escapeXml((entity.text ?? "").replace(/\\P|\r|\n/g, " ").trim());
  if (!text) {
    return "";
  }
  const transform = rotationDeg !== 0 ? ` transform="rotate(${rotationDeg} ${p.x} ${p.y})"` : "";
  return `<text x="${p.x}" y="${p.y}" font-family="${escapeAttr(ctx.fontFamily)}" font-size="${round(fontSize)}" text-anchor="${anchor}" fill="${strokeColor(ctx, entity)}"${transform}>${text}</text>`;
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