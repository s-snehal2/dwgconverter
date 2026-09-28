import type { Color, Entity, Layer } from "@node-projects/acad-ts";
import {
  Line,
  Circle,
  Arc,
  Point,
  Ellipse,
  LwPolyline,
  Polyline,
  Polyline2D,
  Polyline3D,
  TextEntity,
  MText,
  Spline,
  Solid,
  Face3D,
  Hatch,
  Leader,
  RasterImage,
  LayerFlags,
} from "@node-projects/acad-ts";
import type { CadPoint, Entity as ModelsEntity, TextAlignment } from "../models/entity";

/**
 * Translates acad-ts entity instances into our normalized entity model.
 * This is the only module that knows about acad-ts entity classes; the
 * renderer and everything downstream only sees the normalized model.
 */

function point(p: { x: number; y: number; z?: number }): CadPoint {
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * Strip MText inline-formatting codes into plain text. Mirrors acad-ts's
 * TextProcessor.parse but without its infinite-loop bug: acad-ts resets the
 * scan index to 0 when an escape code (`\f`, `\c`, `\h`, `\p`, `\A`, ...) is
 * not terminated by a `;`, which hangs forever on real-world MText strings.
 * This variant always advances, dropping the code and, when present, its
 * `;`-terminated payload. Escaped braces/backslashes and `\P`/`\n` line
 * breaks are preserved; group braces `{`/`}` are dropped.
 */
function mtextPlainText(value: string): string {
  let sb = "";
  let index = 0;
  while (index < value.length) {
    const current = value[index];
    const next = index + 1 < value.length ? value[index + 1] : undefined;
    if (current === "\\" && next !== undefined) {
      switch (next) {
        case "}":
        case "{":
        case "\\":
          sb += next;
          index += 2;
          break;
        case "A":
        case "c":
        case "C":
        case "f":
        case "F":
        case "h":
        case "H":
        case "p": {
          const semi = value.indexOf(";", index);
          index = semi === -1 ? value.length : semi + 1;
          break;
        }
        case "P":
        case "n":
          sb += "\n";
          index += 2;
          break;
        default:
          index += 1;
          break;
      }
    } else if ((current === "{" || current === "}") && next !== "\\" && (index === 0 || value[index - 1] !== "\\")) {
      index += 1;
    } else {
      sb += current;
      index += 1;
    }
  }
  return sb;
}

/** Resolve the effective color to a CSS hex string; white strokes become black. */
function resolveColorHex(color: Color): string {
  const rgb = color.getRgb();
  if (!Array.isArray(rgb) || rgb.length < 3 || rgb.slice(0, 3).some((v) => !Number.isFinite(v))) {
    return "#000000";
  }
  const [r, g, b] = rgb;
  if (r >= 240 && g >= 240 && b >= 240) {
    return "#000000";
  }
  const hex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function layerIsVisible(layer: Layer | null | undefined): boolean {
  if (!layer) {
    return true;
  }
  if (layer.isOn === false) {
    return false;
  }
  const flags = layer.layerFlags ?? LayerFlags.None;
  return (flags & LayerFlags.Frozen) === 0;
}

export function entityLayerName(entity: Entity): string {
  return entity.layer?.name ?? "0";
}

export function entityIsVisible(entity: Entity): boolean {
  if (entity.isInvisible) {
    return false;
  }
  return layerIsVisible(entity.layer);
}

export function entityColorHex(entity: Entity): string {
  try {
    return resolveColorHex(entity.getActiveColor());
  } catch {
    return "#000000";
  }
}

/** Effective lineweight reference value (1/100 mm); negatives mean ByLayer/etc. */
export function entityLineWeightValue(entity: Entity): number {
  try {
    return entity.getActiveLineWeightType();
  } catch {
    return entity.lineWeight;
  }
}

function textAlignment(entity: TextEntity | MText, text: string, height: number): TextAlignment {
  const horizontalRaw = (entity as { horizontalAlignment?: unknown }).horizontalAlignment;
  const verticalRaw = (entity as { verticalAlignment?: unknown }).verticalAlignment;
  void text;
  void height;
  void horizontalRaw;
  void verticalRaw;
  return { horizontal: "left", vertical: "baseline" };
}

function baseProps<T extends ModelsEntity["type"]>(entity: Entity, type: T) {
  return {
    type,
    color: entityColorHex(entity),
    layer: entityLayerName(entity),
    lineWeight: entityLineWeightValue(entity),
    lineType: entity.lineType?.name ?? undefined,
    sourceType: entity.objectName ?? type,
  };
}

/**
 * Tessellate a NURBS spline into a dense polyline. `polygonalVertexes`
 * samples the curve in parameter space; the count is derived from the number
 * of control points so long curves stay smooth without exploding on trivial
 * ones. `tryPolygonalVertexes` degrades gracefully when the knot data is bad.
 */
function splineToPolyline(spline: Spline): ModelsEntity | null {
  const length = Math.max(spline.controlPoints.length, 2);
  const segments = Math.max(24, Math.min(512, Math.round(length * 10)));
  const result = spline.tryPolygonalVertexes(segments);
  if (!result.success || result.points.length < 2) {
    return null;
  }
  return {
    ...baseProps(spline, "POLYLINE"),
    vertices: result.points.map((p) => ({ x: p.x, y: p.y })),
    closed: spline.isClosed || spline.isPeriodic,
    bulges: result.points.map(() => 0),
  };
}

/** The 3/4 corners of a SOLID or 3DFACE as an x/y list. */
function solidVertices(points: Array<{ x: number; y: number }>): CadPoint[] {
  const vertices: CadPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      continue;
    }
    vertices.push({ x: p.x, y: p.y });
  }
  return vertices;
}

/**
 * The placement quadrilateral of a raster IMAGE: the insertion point plus the
 * u/v axis vectors give its four corners. Consecutive duplicates are dropped
 * and only finite coordinates are kept.
 */
function rasterImageVertices(image: RasterImage): CadPoint[] {
  const insert = image.insertPoint;
  const u = image.uVector;
  const v = image.vVector;
  const candidates = [
    { x: insert.x, y: insert.y },
    { x: insert.x + u.x, y: insert.y + u.y },
    { x: insert.x + u.x + v.x, y: insert.y + u.y + v.y },
    { x: insert.x + v.x, y: insert.y + v.y },
  ];
  const vertices: CadPoint[] = [];
  for (const p of candidates) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      continue;
    }
    const last = vertices[vertices.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) {
      vertices.push(p);
    }
  }
  return vertices;
}

/**
 * Convert one hatch into normalized entities. Solid/plain hatches become one
 * filled polygon per boundary loop; pattern hatches are exploded into their
 * line segments so the fill pattern is reproduced faithfully.
 */
export function extractHatch(hatch: Hatch): ModelsEntity[] {
  const color = entityColorHex(hatch);
  const layer = entityLayerName(hatch);
  const lineWeight = entityLineWeightValue(hatch);
  const lineType = hatch.lineType?.name ?? undefined;
  const base = { color, layer, lineWeight, lineType };

  const isPattern = hatch.pattern && hatch.pattern.lines.length > 0;

  // Pattern hatch: draw the hatched segments clipped to the boundary loops.
  if (isPattern) {
    const entities: ModelsEntity[] = [];
    try {
      for (const line of hatch.explodePattern()) {
        const normalized = extractEntity(line);
        if (normalized) {
          entities.push(normalized);
        }
      }
    } catch {
      // Fall back to the boundary outline below.
    }
    if (entities.length > 0) {
      return entities;
    }
  }

  // Solid hatch (or pattern-explode failure): fill the boundary loops.
  const loops: ModelsEntity[] = [];
  for (const path of hatch.paths) {
    const points = path.getPoints(128);
    const vertices = solidVertices(points);
    if (vertices.length < 3) {
      continue;
    }
    // Boundary edges share endpoints, so drop consecutive duplicates and a
    // trailing copy of the first point to keep the polygon clean.
    const cleaned: CadPoint[] = [];
    for (const v of vertices) {
      const last = cleaned[cleaned.length - 1];
      if (!last || Math.abs(last.x - v.x) > 1e-9 || Math.abs(last.y - v.y) > 1e-9) {
        cleaned.push(v);
      }
    }
    if (cleaned.length < 3) {
      continue;
    }
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    const closedLoop =
      Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9 ? cleaned : [...cleaned, first];
    loops.push({ ...base, sourceType: "HATCH", type: "SOLID", vertices: closedLoop, filled: true });
  }
  return loops;
}

/**
 * Convert one LEADER into a polyline plus an optional filled arrowhead. The
 * leader path is stored in world coordinates; the arrowhead is a triangle
 * projected back from the tip along the final segment.
 */
export function extractLeader(leader: Leader): ModelsEntity[] {
  const vertices: CadPoint[] = [];
  for (const v of leader.vertices ?? []) {
    if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
      vertices.push({ x: v.x, y: v.y });
    }
  }
  if (vertices.length === 0) {
    return [];
  }

  const polyline: ModelsEntity = {
    ...baseProps(leader, "POLYLINE"),
    vertices,
    closed: false,
    bulges: vertices.map(() => 0),
  };
  if (!leader.arrowHeadEnabled || vertices.length < 2) {
    return [polyline];
  }

  const tip = vertices[vertices.length - 1];
  const before = vertices[vertices.length - 2];
  const dx = tip.x - before.x;
  const dy = tip.y - before.y;
  const segmentLength = Math.hypot(dx, dy);
  if (segmentLength <= 1e-9) {
    return [polyline];
  }

  // Arrow size precedence: the dimension style's value scaled to world units
  // when it lands in a sane proportion of the segment, otherwise a visual
  // default so short and unit-mismatched leaders stay legible.
  const styleArrow = leader.style?.arrowSize ?? 0;
  const styleScale = leader.style?.scaleFactor ?? 0;
  const scaledArrow = styleArrow * (styleScale > 0 ? styleScale : 1);
  const arrowLength =
    scaledArrow >= segmentLength * 0.02 && scaledArrow <= segmentLength * 0.25
      ? scaledArrow
      : segmentLength * 0.08;

  const dirX = dx / segmentLength;
  const dirY = dy / segmentLength;
  const perpX = -dirY;
  const perpY = dirX;
  const baseX = tip.x - dirX * arrowLength;
  const baseY = tip.y - dirY * arrowLength;
  const halfWidth = arrowLength * 0.22;
  const left: CadPoint = { x: baseX + perpX * halfWidth, y: baseY + perpY * halfWidth };
  const right: CadPoint = { x: baseX - perpX * halfWidth, y: baseY - perpY * halfWidth };

  const arrowhead: ModelsEntity = {
    ...baseProps(leader, "SOLID"),
    vertices: [left, tip, right],
    filled: true,
  };
  return [polyline, arrowhead];
}

/**
 * Map one acad-ts entity to a normalized entity. Returns null for entity
 * types this MVP does not render.
 */
export function extractEntity(entity: Entity): ModelsEntity | null {
  if (entity instanceof Line) {
    return { ...baseProps(entity, "LINE"), start: point(entity.startPoint), end: point(entity.endPoint) };
  }
  if (entity instanceof Arc) {
    return {
      ...baseProps(entity, "ARC"),
      center: point(entity.center),
      radius: entity.radius,
      startAngle: entity.startAngle,
      endAngle: entity.endAngle,
    };
  }
  if (entity instanceof Circle) {
    return { ...baseProps(entity, "CIRCLE"), center: point(entity.center), radius: entity.radius };
  }
  if (entity instanceof Point) {
    return { ...baseProps(entity, "POINT"), position: point(entity.location) };
  }
  if (entity instanceof Ellipse) {
    return {
      ...baseProps(entity, "ELLIPSE"),
      center: point(entity.center),
      majorAxisEndPoint: point(entity.majorAxisEndPoint),
      radiusRatio: entity.radiusRatio,
      startAngle: entity.startParameter,
      endAngle: entity.endParameter,
      full: entity.isFullEllipse,
    };
  }
  if (entity instanceof LwPolyline) {
    return {
      ...baseProps(entity, "POLYLINE"),
      vertices: entity.vertices.map((v) => point(v.location)),
      closed: entity.isClosed,
      bulges: entity.vertices.map((v) => v.bulge),
    };
  }
  if (entity instanceof Polyline2D || entity instanceof Polyline3D || entity instanceof Polyline) {
    const vertices = entity.vertices;
    const locations: CadPoint[] = [];
    const bulges: number[] = [];
    const iterator = vertices as Iterable<Entity & { location?: { x: number; y: number }; bulge?: number }>;
    for (const vertex of iterator) {
      if (vertex?.location) {
        locations.push({ x: vertex.location.x, y: vertex.location.y });
        bulges.push(vertex.bulge ?? 0);
      }
    }
    if (locations.length === 0) {
      return null;
    }
    return {
      ...baseProps(entity, "POLYLINE"),
      vertices: locations,
      closed: entity.isClosed,
      bulges,
    };
  }
  if (entity instanceof TextEntity) {
    return {
      ...baseProps(entity, "TEXT"),
      position: point(entity.insertPoint),
      rotation: entity.rotation,
      height: entity.height,
      text: entity.value ?? "",
      alignment: textAlignment(entity, entity.value ?? "", entity.height),
    };
  }
  if (entity instanceof MText) {
    return {
      ...baseProps(entity, "MTEXT"),
      position: point(entity.insertPoint),
      rotation: entity.rotation,
      height: entity.height,
      text: mtextPlainText(entity.value ?? ""),
      width: entity.rectangleWidth,
      alignment: textAlignment(entity, entity.value ?? "", entity.height),
    };
  }
  if (entity instanceof Spline) {
    return splineToPolyline(entity);
  }
  if (entity instanceof Solid) {
    const vertices = solidVertices([entity.firstCorner, entity.secondCorner, entity.thirdCorner, entity.fourthCorner]);
    if (vertices.length < 3) {
      return null;
    }
    return { ...baseProps(entity, "SOLID"), vertices, filled: true };
  }
  if (entity instanceof Face3D) {
    const vertices = solidVertices([entity.firstCorner, entity.secondCorner, entity.thirdCorner, entity.fourthCorner]);
    if (vertices.length < 3) {
      return null;
    }
    return { ...baseProps(entity, "SOLID"), vertices, filled: false };
  }
  if (entity instanceof RasterImage) {
    // The DWG references an external image file whose pixels are not part of
    // the drawing, so the image is normalized to its placement frame.
    const vertices = rasterImageVertices(entity);
    if (vertices.length < 3) {
      return null;
    }
    return { ...baseProps(entity, "IMAGE"), vertices };
  }
  return null;
}

export interface LayerNormalizationResult {
  name: string;
  visible: boolean;
  color?: string;
  lineWeight?: number;
  lineType?: string;
}

export function normalizeLayer(layer: Layer): LayerNormalizationResult {
  return {
    name: layer.name,
    visible: layerIsVisible(layer),
    color: colorToCssHex(layer.color),
    lineWeight: layer.lineWeight,
    lineType: layer.lineType?.name ?? undefined,
  };
}

function colorToCssHex(color: Color | null | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  return resolveColorHex(color);
}