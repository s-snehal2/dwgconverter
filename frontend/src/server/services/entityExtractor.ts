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
  PolylineFlags,
  TextEntity,
  MText,
  Spline,
  Solid,
  Face3D,
  Hatch,
  Leader,
  MultiLeader,
  MLine,
  XLine,
  Ray,
  Tolerance,
  Mesh,
  PolygonMesh,
  PolyfaceMesh,
  ModelerGeometry,
  TableEntity,
  Ole2Frame,
  Shape,
  Wall,
  UnderlayEntity,
  UnderlayDisplayFlags,
  RasterImage,
  LayerFlags,
} from "@node-projects/acad-ts";
import type { CadPoint, Entity as ModelsEntity, TextAlignment } from "../models/entity";
import { DEFAULT_TEXT_HEIGHT } from "./textMetrics";

/**
 * Translates acad-ts entity instances into our normalized entity model.
 * This is the only module that knows about acad-ts entity classes; the
 * renderer and everything downstream only sees the normalized model.
 */

function point(p: { x: number; y: number; z?: number }): CadPoint {
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * Inline codes that take a `;`-terminated payload and contribute no text of
 * their own: alignment, colours, fonts, widths, heights, tracking, obliquing,
 * paragraph properties and the underline/overline/strike toggles.
 */
const MTEXT_PAYLOAD_CODES = "AaCcFfHhKkLlOoPpQqTtWwXxMm";

/** MTEXT legacy control codes: `%%d` degree, `%%c` diameter, `%%p` plus/minus. */
function legacyControlCode(code: string): string {
  switch (code) {
    case "d":
    case "D":
      return "\u00b0";
    case "c":
    case "C":
      return "\u00d8";
    case "p":
    case "P":
      return "\u00b1";
    case "%":
      return "%";
    default:
      return "";
  }
}

/**
 * Unicode vulgar fractions, so an architectural dimension like `6{\S1/2;}"` is
 * drawn `6½"` as AutoCAD does. Emitting the plain digits instead yields `61/2"`,
 * which reads as sixty-one halves rather than six and a half.
 */
const VULGAR_FRACTIONS: Record<string, string> = {
  "1/2": "\u00bd",
  "1/3": "\u2153",
  "2/3": "\u2154",
  "1/4": "\u00bc",
  "3/4": "\u00be",
  "1/5": "\u2155",
  "2/5": "\u2156",
  "3/5": "\u2157",
  "4/5": "\u2158",
  "1/6": "\u2159",
  "5/6": "\u215a",
  "1/7": "\u2150",
  "1/8": "\u215b",
  "3/8": "\u215c",
  "5/8": "\u215d",
  "7/8": "\u215e",
  "1/9": "\u2151",
  "1/10": "\u2152",
};

/**
 * Flatten one `\S` stacked-text payload. AutoCAD stacks the digits and draws a
 * fraction bar; the closest single-glyph match is the Unicode vulgar fraction.
 * Payloads that are not a plain fraction (overline/overline-bar groups, or a
 * numerator and denominator that have no glyph) fall back to `n/d`.
 */
function stackedFraction(payload: string): string {
  const flattened = payload.replace(/[/#^]/g, "/").replace(/\s+/g, "");
  const glyph = VULGAR_FRACTIONS[flattened];
  if (glyph) {
    return glyph;
  }
  // Levels are commonly signed, as in `+3{\S3/4;}" lvl`, so match the digits
  // on their own and keep the sign outside the glyph.
  const signed = /^([+-]?)(\d+\/\d+)$/.exec(flattened);
  if (signed) {
    return signed[1] + (VULGAR_FRACTIONS[signed[2]] ?? signed[2]);
  }
  return flattened;
}

/**
 * Strip MText inline-formatting codes into plain text. Mirrors acad-ts's
 * TextProcessor.parse but without its infinite-loop bug: acad-ts resets the
 * scan index to 0 when an escape code (`\f`, `\c`, `\h`, `\p`, `\A`, ...) is
 * not terminated by a `;`, which hangs forever on real-world MText strings.
 * This variant always advances, dropping the code and, when present, its
 * `;`-terminated payload. Escaped braces/backslashes and `\P`/`\n` line
 * breaks are preserved; group braces `{`/`}` are dropped.
 *
 * On top of acad-ts this handles stacked fractions (`\S`), Unicode escapes
 * (`\U+00B0`), non-breaking spaces (`\~`) and the legacy `%%d/%%c/%%p`
 * control codes, all of which are common in title blocks and dimension
 * annotations.
 */
function mtextPlainText(value: string): string {
  let sb = "";
  let index = 0;
  while (index < value.length) {
    const current = value[index];
    const next = index + 1 < value.length ? value[index + 1] : undefined;
    if (current === "%" && next === "%") {
      const decoded = legacyControlCode(value[index + 2] ?? "");
      if (decoded) {
        sb += decoded;
        index += 3;
        continue;
      }
      sb += "%%";
      index += 2;
      continue;
    }
    if (current === "\\" && next !== undefined) {
      if (next === "}" || next === "{" || next === "\\") {
        sb += next;
        index += 2;
        continue;
      }
      // Line and column breaks, and paragraph breaks.
      if (next === "P" || next === "n" || next === "N") {
        sb += "\n";
        index += 2;
        continue;
      }
      if (next === "~") {
        sb += " ";
        index += 2;
        continue;
      }
      // Stacked fraction/overline text: `\S1^2;` becomes the `½` glyph.
      if (next === "S") {
        const semi = value.indexOf(";", index);
        if (semi !== -1) {
          sb += stackedFraction(value.slice(index + 2, semi));
          index = semi + 1;
        } else {
          index += 2;
        }
        continue;
      }
      // Unicode escape: `\U+00B0`.
      if (next === "U" && value[index + 2] === "+") {
        const code = Number.parseInt(value.slice(index + 3, index + 7), 16);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          sb += String.fromCodePoint(code);
          index += 7;
          continue;
        }
        index += 2;
        continue;
      }
      if (MTEXT_PAYLOAD_CODES.includes(next)) {
        const semi = value.indexOf(";", index);
        if (semi !== -1) {
          index = semi + 1;
          continue;
        }
        // Real-world MText sometimes omits the terminator, e.g.
        // `{\fCentury Gothic|b1|i0|c0|p34  FRONT ELEVATION}`. Skipping only the
        // code letter left the whole font spec behind as visible text, so stop
        // the payload at the run of whitespace AutoCAD uses to delimit a font
        // run from the text that follows it.
        const stop = value.slice(index + 2).search(/\s{2,}/);
        index = stop === -1 ? index + 2 : index + 2 + stop;
        continue;
      }
      index += 1;
      continue;
    }
    // Formatting-group braces are never drawn. Escaped `\{` / `\}` were already
    // consumed above, so any brace reaching here is a group delimiter. The
    // previous `next !== "\\"` guard also spared the opening brace of a group
    // whose first inline code follows immediately (`{\H1x;...}`, `{\f...;...}`),
    // which leaked a literal "{" into every such label.
    if (current === "{" || current === "}") {
      index += 1;
      continue;
    }
    sb += current;
    index += 1;
  }
  return sb;
}

/** Resolve an arbitrary acad-ts color to CSS hex; used for synthetic entities. */
export function cssHexFromColor(color: Color | null | undefined): string {
  if (!color) {
    return "#000000";
  }
  try {
    return resolveColorHex(color);
  } catch {
    return "#000000";
  }
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

/**
 * Map acad-ts text placement onto the renderer's anchor model.
 *
 * `TEXT` and `MTEXT` do not use the same vocabulary: a `TextEntity` carries
 * separate horizontal/vertical enums, while an `MText` carries one 1..9 grid
 * attachment point. Both are reduced to a `{horizontal, vertical}` pair that
 * `renderText` turns into an SVG `text-anchor`.
 *
 * The renderer only anchors horizontally, so `Aligned`, `Middle` and `Fit`
 * (which AutoCAD resolves against a reference line or the fitted width) are all
 * treated as centre — the closest faithful approximation without the reference
 * geometry.
 */
function textAlignment(entity: TextEntity | MText): TextAlignment {
  if (entity instanceof MText) {
    // AttachmentPointType: 1-3 top, 4-6 middle, 7-9 bottom; 1/4/7 left,
    // 2/5/8 centre, 3/6/9 right.
    const point = entity.attachmentPoint;
    return {
      horizontal: point === 1 || point === 4 || point === 7 ? "left" : point === 3 || point === 6 || point === 9 ? "right" : "center",
      vertical: point <= 3 ? "top" : point >= 7 ? "bottom" : "middle",
    };
  }

  // TextHorizontalAlignment: Left 0, Center 1, Right 2, Aligned 3, Middle 4, Fit 5.
  const horizontal = entity.horizontalAlignment;
  // TextVerticalAlignmentType: Baseline 0, Bottom 1, Middle 2, Top 3.
  const vertical = entity.verticalAlignment;
  return {
    horizontal: horizontal === 2 ? "right" : horizontal === 0 ? "left" : "center",
    vertical: vertical === 3 ? "top" : vertical === 2 ? "middle" : vertical === 1 ? "bottom" : "baseline",
  };
}

/** Tolerance around unit magnitude when spotting acad-ts's placeholder points. */
const UNIT_POINT_TOLERANCE = 0.01;

/**
 * Whether an `alignmentPoint` is unusable as a text anchor.
 *
 * acad-ts does not read the MTEXT/TEXT alignment point out of the DWG at all: it
 * leaves a *unit direction vector* there instead. Across the 1,867 text entities
 * of a real architectural drawing every value had magnitude 1 — `(1,0)`,
 * `(0,1)`, `(0,-1)`, `(-1,0)`, and rotations such as `(0.99998, 0.00473)` —
 * which is 82 distinct values, all of them directions rather than positions.
 *
 * Because `textPosition` prefers `alignmentPoint` for anything that is not
 * left/baseline aligned, trusting it drew all 817 dimension values plus every
 * centred label at the origin, roughly 100,000 units from the geometry they
 * annotate, which is what made dimension text read as missing.
 *
 * A real anchor in a drawing whose model space spans ~120,000 units is orders of
 * magnitude away from a unit vector, so magnitude separates the two reliably.
 * The degenerate origin is rejected too. Any engine that genuinely populates the
 * field with drawing coordinates still takes the AutoCAD-correct path below.
 */
function isUnusableAlignmentPoint(value: { x: number; y: number } | undefined | null): boolean {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    return true;
  }
  const magnitude = Math.hypot(value.x, value.y);
  return magnitude < UNIT_POINT_TOLERANCE || Math.abs(magnitude - 1) <= UNIT_POINT_TOLERANCE;
}

/**
 * The point a text entity is actually placed at.
 *
 * AutoCAD only stores the true anchor in `alignmentPoint` when the text is *not*
 * left/baseline aligned; otherwise `insertPoint` is the anchor. Reading the
 * wrong one puts centred or right-aligned labels — most of a title block — at
 * an arbitrary offset from where they belong.
 *
 * `alignmentPoint` is only honoured when it holds a real coordinate; see
 * `isUnusableAlignmentPoint`. In practice that means every label is anchored on
 * its group-10 insert point, which acad-ts populates correctly for all of them.
 */
function textPosition(entity: TextEntity | MText): CadPoint {
  const alignment = textAlignment(entity);
  const needsAlignmentPoint = alignment.horizontal !== "left" || alignment.vertical !== "baseline";
  const alignmentPoint = entity.alignmentPoint;
  const anchor =
    needsAlignmentPoint && !isUnusableAlignmentPoint(alignmentPoint)
      ? alignmentPoint
      : entity.insertPoint;
  return point(anchor);
}

/**
 * Effective cap height of a text entity.
 *
 * A DWG may legitimately store a height of 0, in which case AutoCAD falls back
 * to the text style's height (`lastHeight` is the height last used with the
 * style). Passing the raw 0 through made every such label collapse onto the
 * renderer's minimum-size clamp and look like missing text, so the style
 * heights are consulted before falling back to a sane drawing-unit default.
 *
 * `dimensionTextHeight` is the owning DIMENSION's style text height, supplied
 * only for entities expanded out of a dimension block. It matters because that
 * last-resort `DEFAULT_TEXT_HEIGHT` of 1 is catastrophic here: acad-ts's own
 * default dimension text height is 0.18, and a dimension block's MTEXT carries
 * the measured value, so every dimension in a drawing landing on 1 drew them
 * roughly 5.5x oversized — on a 36-unit sheet at 3000px, about 115px of type
 * where a real annotation is 8px. The dimension style knows the intended size,
 * so it is preferred over the generic default whenever it is available.
 */
function textEntityHeight(entity: TextEntity | MText, dimensionTextHeight?: number): number {
  if (Number.isFinite(entity.height) && entity.height > 0) {
    return entity.height;
  }
  const style = entity.style as unknown as { height?: unknown; lastHeight?: unknown } | null;
  const fromStyle = [style?.height, style?.lastHeight].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
  );
  if (fromStyle !== undefined) {
    return fromStyle;
  }
  if (dimensionTextHeight !== undefined && dimensionTextHeight > 0) {
    return dimensionTextHeight;
  }
  return DEFAULT_TEXT_HEIGHT;
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

function isFinitePoint(p: { x: number; y: number } | null | undefined): p is { x: number; y: number } {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Expand an MLINE into its element lines.
 *
 * Each vertex carries `parameters` — the element offsets measured along the
 * vertex's miter direction (already scaled by the reader). One polyline is
 * emitted per distinct offset; the centerline is only drawn when the offsets
 * are absent, so walls drawn as two parallel lines stay two lines.
 */
export function extractMline(mline: MLine): ModelsEntity[] {
  const raw = mline.vertices ?? [];
  const good = raw.filter(
    (v): v is NonNullable<typeof v> => !!v && !!v.position && Number.isFinite(v.position.x) && Number.isFinite(v.position.y)
  );
  if (good.length < 2) {
    return [];
  }
  const offsets = new Set<number>();
  for (const v of good) {
    const params = v.segments?.[0]?.parameters ?? [];
    for (const p of params) {
      if (Number.isFinite(p)) {
        offsets.add(p);
      }
    }
  }
  const lines: ModelsEntity[] = [];
  const pushLine = (vertices: CadPoint[]): void => {
    if (vertices.length >= 2) {
      lines.push({
        ...baseProps(mline, "POLYLINE"),
        vertices,
        closed: false,
        bulges: vertices.map(() => 0),
      });
    }
  };
  if (offsets.size === 0) {
    pushLine(good.map((v) => point(v.position)));
    return lines;
  }
  for (const offset of offsets) {
    const vertices: CadPoint[] = [];
    for (const v of good) {
      const miter = v.miter;
      const miterLen = miter ? Math.hypot(miter.x, miter.y) : 0;
      if (!(miterLen > 1e-12)) {
        vertices.push(point(v.position));
        continue;
      }
      vertices.push({
        x: v.position.x + (miter.x / miterLen) * offset,
        y: v.position.y + (miter.y / miterLen) * offset,
      });
    }
    pushLine(vertices);
  }
  return lines;
}

/**
 * Normalize an XLINE (infinite both ways) or RAY (half-infinite) to a unit
 * direction segment. `dwgParser.resolveInfiniteLines` later stretches it to
 * the sheet's own diagonal, so the line always spans the drawing it belongs to
 * instead of either vanishing or blowing up the canvas bounds.
 */
export function extractInfiniteLine(
  source: XLine | Ray,
  from: { x: number; y: number },
  direction: { x: number; y: number },
  sourceType: "XLINE" | "RAY"
): ModelsEntity | null {
  if (!isFinitePoint(from)) {
    return null;
  }
  const len = Math.hypot(direction.x, direction.y);
  if (!(len > 1e-12) || !Number.isFinite(len)) {
    return null;
  }
  const start = point(from);
  return {
    ...baseProps(source, "LINE"),
    sourceType,
    start,
    end: { x: from.x + direction.x / len, y: from.y + direction.y / len },
  };
}

/** Frame + label of a TOLERANCE entity (geometric tolerance callout). */
export function extractTolerance(tolerance: Tolerance): ModelsEntity[] {
  const text = (tolerance.text ?? "").trim();
  if (!text) {
    return [];
  }
  const rawHeight = (tolerance.style as unknown as { textHeight?: unknown } | null)?.textHeight;
  const height = typeof rawHeight === "number" && rawHeight > 0 ? rawHeight : 1;
  const center = point(tolerance.insertionPoint);
  if (!isFinitePoint(center)) {
    return [];
  }
  const halfW = (text.length * height * 0.6) / 2 + height * 0.3;
  const halfH = height * 0.9;
  const frame: ModelsEntity = {
    ...baseProps(tolerance, "SOLID"),
    vertices: [
      { x: center.x - halfW, y: center.y - halfH },
      { x: center.x + halfW, y: center.y - halfH },
      { x: center.x + halfW, y: center.y + halfH },
      { x: center.x - halfW, y: center.y + halfH },
    ],
    filled: false,
  };
  const label: ModelsEntity = {
    ...baseProps(tolerance, "TEXT"),
    position: center,
    rotation: 0,
    height,
    text,
    alignment: { horizontal: "center", vertical: "middle" },
  };
  return [frame, label];
}

/**
 * Outline polylines of a 3D-solid BODY/REGION (ACIS `wires`). Each wire is a
 * point loop in world coordinates; unclosed wires stay open polylines, loops
 * whose last point repeats the first are marked closed.
 */
export function extractModelerWires(geom: ModelerGeometry): ModelsEntity[] {
  const out: ModelsEntity[] = [];
  for (const wire of geom.wires ?? []) {
    const vertices = (wire.points ?? []).filter(isFinitePoint).map((p) => ({ x: p.x, y: p.y }));
    if (vertices.length < 2) {
      continue;
    }
    const first = vertices[0];
    const last = vertices[vertices.length - 1];
    const closed =
      vertices.length > 2 &&
      Math.abs(first.x - last.x) < 1e-9 &&
      Math.abs(first.y - last.y) < 1e-9;
    out.push({
      ...baseProps(geom, "POLYLINE"),
      vertices: closed ? vertices.slice(0, -1) : vertices,
      closed,
      bulges: vertices.map(() => 0),
    });
  }
  return out;
}

function unfilledPolygon(source: Entity, vertices: CadPoint[]): ModelsEntity | null {
  if (vertices.length < 3) {
    return null;
  }
  return { ...baseProps(source, "SOLID"), vertices, filled: false };
}

/** Faces of a sub-D MESH (`faces` index into `vertices`). */
export function extractMeshFaces(mesh: Mesh): ModelsEntity[] {
  const verts = mesh.vertices ?? [];
  const out: ModelsEntity[] = [];
  for (const face of mesh.faces ?? []) {
    if (!Array.isArray(face)) {
      continue;
    }
    const vertices = face
      .map((index) => verts[index])
      .filter((v): v is NonNullable<typeof v> => !!v && Number.isFinite(v.x) && Number.isFinite(v.y))
      .map((v) => ({ x: v.x, y: v.y }));
    const polygon = unfilledPolygon(mesh, vertices);
    if (polygon) {
      out.push(polygon);
    }
  }
  return out;
}

function meshVertexLocations(polyline: PolygonMesh | PolyfaceMesh): Array<{ x: number; y: number } | null> {
  const locations: Array<{ x: number; y: number } | null> = [];
  const iterator = polyline.vertices as Iterable<{ location?: { x: number; y: number } } | null | undefined>;
  for (const vertex of iterator) {
    const at = vertex?.location;
    locations.push(at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null);
  }
  return locations;
}

/**
 * Faces of a POLYGON MESH (`mVertexCount` × `nVertexCount` grid). Returns null
 * when the counts disagree with the vertex list so the caller can fall back
 * to the generic vertex soup rather than drawing a wrong tessellation.
 */
export function extractPolygonMeshFaces(mesh: PolygonMesh): ModelsEntity[] | null {
  const m = Math.floor(mesh.mVertexCount);
  const n = Math.floor(mesh.nVertexCount);
  const locations = meshVertexLocations(mesh);
  if (!(m >= 2) || !(n >= 2) || locations.length < m * n) {
    return null;
  }
  const flags = mesh.flags ?? 0;
  const wrapM = (flags & PolylineFlags.ClosedPolylineOrClosedPolygonMeshInM) !== 0;
  const wrapN = (flags & PolylineFlags.ClosedPolygonMeshInN) !== 0;
  const at = (i: number, j: number): { x: number; y: number } | null => {
    const ii = wrapM ? ((i % m) + m) % m : i;
    const jj = wrapN ? ((j % n) + n) % n : j;
    if (ii < 0 || ii >= m || jj < 0 || jj >= n) {
      return null;
    }
    return locations[jj * m + ii];
  };
  const out: ModelsEntity[] = [];
  const rows = wrapN ? n : n - 1;
  const cols = wrapM ? m : m - 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (quad.some((p) => !p)) {
        continue;
      }
      const polygon = unfilledPolygon(mesh, quad as CadPoint[]);
      if (polygon) {
        out.push(polygon);
      }
    }
  }
  return out;
}

/**
 * Faces of a POLYFACE MESH. Face indices are 1-based into the vertex list
 * (index 0 is the dummy header vertex); 0 ends the face, negative values mark
 * invisible edges but still belong to the face. Returns null on inconsistent
 * data so the caller falls back to the generic path.
 */
export function extractPolyfaceMeshFaces(mesh: PolyfaceMesh): ModelsEntity[] | null {
  const locations = meshVertexLocations(mesh);
  const faces = mesh.faces ?? [];
  if (faces.length === 0 || locations.length === 0) {
    return null;
  }
  const out: ModelsEntity[] = [];
  for (const face of faces) {
    if (!face) {
      continue;
    }
    const indices = [face.index1, face.index2, face.index3, face.index4]
      .map((index) => Math.abs(Math.trunc(index)))
      .filter((index) => index > 0 && index < locations.length);
    const vertices = indices
      .map((index) => locations[index])
      .filter((p): p is { x: number; y: number } => !!p);
    if (vertices.length < 3) {
      continue;
    }
    const polygon = unfilledPolygon(mesh, vertices);
    if (polygon) {
      out.push(polygon);
    }
  }
  return out;
}

/**
 * Grid + cell text of a TABLE (schedule, parts list, title block rows).
 * Geometry comes from the row heights and column widths laid from the insert
 * point along the table's horizontal direction (rows grow downwards, as in
 * AutoCAD); each cell becomes an outline plus its formatted value.
 */
export function extractTableEntities(table: TableEntity): ModelsEntity[] {
  const rows = table.rows ?? [];
  const columns = table.columns ?? [];
  const widths = columns.map((c) => c?.width);
  const heights = rows.map((r) => r?.height);
  if (rows.length === 0 || columns.length === 0) {
    return [];
  }
  if (widths.some((w) => !(typeof w === "number" && w > 0)) || heights.some((h) => !(typeof h === "number" && h > 0))) {
    return [];
  }
  const origin = table.insertPoint;
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    return [];
  }
  const rawDir = table.horizontalDirection;
  const dirLen = rawDir ? Math.hypot(rawDir.x, rawDir.y) : 0;
  const hx = dirLen > 1e-12 ? rawDir.x / dirLen : 1;
  const hy = dirLen > 1e-12 ? rawDir.y / dirLen : 0;
  // Rows grow downwards from the insertion (top) edge.
  const vx = hy;
  const vy = -hx;
  const corner = (col: number, row: number): CadPoint => {
    let dx = 0;
    for (let c = 0; c < col; c++) {
      dx += widths[c] as number;
    }
    let dy = 0;
    for (let r = 0; r < row; r++) {
      dy += heights[r] as number;
    }
    return { x: origin.x + hx * dx + vx * dy, y: origin.y + hy * dx + vy * dy };
  };
  const out: ModelsEntity[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < columns.length; c++) {
      const quad = [corner(c, r), corner(c + 1, r), corner(c + 1, r + 1), corner(c, r + 1)];
      const cell = unfilledPolygon(table, quad);
      if (cell) {
        out.push(cell);
      }
      const record = rows[r].cells?.[c];
      const texts: string[] = [];
      for (const content of record?.contents ?? []) {
        const value = content?.cadValue;
        const formatted = value?.formattedValue ?? value?.value;
        if (typeof formatted === "string" && formatted.trim()) {
          texts.push(formatted.trim());
        } else if (typeof formatted === "number" && Number.isFinite(formatted)) {
          texts.push(String(formatted));
        }
      }
      if (texts.length === 0) {
        continue;
      }
      const colW = widths[c] as number;
      const rowH = heights[r] as number;
      const formatHeight = record?.contents?.[0]?.format?.textHeight;
      const height =
        typeof formatHeight === "number" && formatHeight > 0
          ? formatHeight
          : Math.min(colW, rowH) * 0.35;
      if (!(height > 0)) {
        continue;
      }
      const center = {
        x: (quad[0].x + quad[2].x) / 2,
        y: (quad[0].y + quad[2].y) / 2,
      };
      const rotation = typeof record?.rotation === "number" ? record.rotation : 0;
      out.push({
        ...baseProps(table, "TEXT"),
        position: center,
        rotation,
        height,
        text: texts.join(" "),
        alignment: { horizontal: "center", vertical: "middle" },
      });
    }
  }
  return out;
}

/**
 * Leader lines + label of a MULTILEADER. Block-content multileaders keep only
 * their leader geometry (the referenced block is resolved by the INSERT path
 * when it is actually present in the drawing).
 */
export function extractMultiLeader(multileader: MultiLeader): ModelsEntity[] {
  const context = multileader.contextData;
  if (!context) {
    return [];
  }
  const out: ModelsEntity[] = [];
  for (const root of context.leaderRoots ?? []) {
    for (const line of root.lines ?? []) {
      const vertices = (line.points ?? []).filter(isFinitePoint).map((p) => ({ x: p.x, y: p.y }));
      if (vertices.length >= 2) {
        out.push({
          ...baseProps(multileader, "POLYLINE"),
          vertices,
          closed: false,
          bulges: vertices.map(() => 0),
        });
      }
    }
  }
  const label = (context.textLabel ?? "").trim();
  if (context.hasTextContents && label) {
    const height = typeof context.textHeight === "number" && context.textHeight > 0 ? context.textHeight : 1;
    const at = context.textLocation;
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      const explicit = cssHexFromColor(context.textColor ?? null);
      out.push({
        ...baseProps(multileader, "TEXT"),
        color: explicit !== "#000000" ? explicit : entityColorHex(multileader),
        position: { x: at.x, y: at.y },
        rotation: typeof context.textRotation === "number" ? context.textRotation : 0,
        height,
        text: label,
        alignment: { horizontal: "center", vertical: "middle" },
      });
    }
  }
  return out;
}

/**
 * Placement frame of a PDF/DGN underlay clipped to a boundary. Without a clip
 * boundary the definition carries no size, so null is returned and the caller
 * records an honest warning instead of inventing geometry.
 */
export function extractUnderlayFrame(underlay: UnderlayEntity): ModelsEntity | null {
  const clip = underlay.clipBoundaryVertices ?? [];
  const clipping = (underlay.flags & UnderlayDisplayFlags.ClippingOn) !== 0;
  if (!clipping || clip.length < 3) {
    return null;
  }
  const insert = underlay.insertPoint;
  if (!insert || !Number.isFinite(insert.x) || !Number.isFinite(insert.y)) {
    return null;
  }
  const rotation = typeof underlay.rotation === "number" ? underlay.rotation : 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const xs = typeof underlay.xScale === "number" && underlay.xScale > 0 ? underlay.xScale : 1;
  const ys = typeof underlay.yScale === "number" && underlay.yScale > 0 ? underlay.yScale : 1;
  const vertices = clip
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      x: insert.x + (p.x * xs * cos - p.y * ys * sin),
      y: insert.y + (p.x * xs * sin + p.y * ys * cos),
    }));
  if (vertices.length < 3) {
    return null;
  }
  return { ...baseProps(underlay, "IMAGE"), vertices };
}

/** Placement frame of an embedded OLE object (upper-left/lower-right corners). */
export function extractOleFrame(ole: Ole2Frame): ModelsEntity | null {
  const ul = ole.upperLeftCorner;
  const lr = ole.lowerRightCorner;
  if (!isFinitePoint(ul) || !isFinitePoint(lr) || ul.x === lr.x || ul.y === lr.y) {
    return null;
  }
  return {
    ...baseProps(ole, "IMAGE"),
    vertices: [
      { x: ul.x, y: ul.y },
      { x: lr.x, y: ul.y },
      { x: lr.x, y: lr.y },
      { x: ul.x, y: lr.y },
    ],
  };
}

/**
 * Plan-view rectangle of an AEC wall (start/end centerline plus width), or a
 * plain centerline when the width is missing.
 */
export function extractWallRect(wall: Wall): ModelsEntity | null {
  const s = wall.startPoint;
  const e = wall.endPoint;
  if (!isFinitePoint(s) || !isFinitePoint(e)) {
    return null;
  }
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-12)) {
    return null;
  }
  const width = typeof wall.width === "number" && wall.width > 0 ? wall.width : 0;
  if (width <= 0) {
    return { ...baseProps(wall, "LINE"), start: { x: s.x, y: s.y }, end: { x: e.x, y: e.y } };
  }
  const px = (-dy / len) * (width / 2);
  const py = (dx / len) * (width / 2);
  return {
    ...baseProps(wall, "SOLID"),
    vertices: [
      { x: s.x + px, y: s.y + py },
      { x: e.x + px, y: e.y + py },
      { x: e.x - px, y: e.y - py },
      { x: s.x - px, y: s.y - py },
    ],
    filled: false,
  };
}

/**
 * A legacy SHAPE (glyph from an external shape file) cannot be reconstructed —
 * acad-ts exposes only its index. Emit its insertion point so the sheet keeps
 * a mark (and honest bounds) instead of silently losing it.
 */
export function extractShapeMark(shape: Shape): ModelsEntity | null {
  const at = shape.insertionPoint;
  if (!isFinitePoint(at)) {
    return null;
  }
  return { ...baseProps(shape, "POINT"), position: { x: at.x, y: at.y } };
}

/**
 * Map one acad-ts entity to a normalized entity. Returns null for entity
 * types this MVP does not render.
 */
export function extractEntity(
  entity: Entity,
  /**
   * Height to use for text whose own height and text style are both unusable.
   * Set by the caller when the entity came out of a DIMENSION block; see
   * `textEntityHeight`.
   */
  dimensionTextHeight?: number
): ModelsEntity | null {
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
      position: textPosition(entity),
      rotation: entity.rotation,
      height: textEntityHeight(entity, dimensionTextHeight),
      text: entity.value ?? "",
      alignment: textAlignment(entity),
      widthFactor: entity.widthFactor,
      oblique: entity.obliqueAngle,
    };
  }
  if (entity instanceof MText) {
    return {
      ...baseProps(entity, "MTEXT"),
      position: textPosition(entity),
      rotation: entity.rotation,
      height: textEntityHeight(entity, dimensionTextHeight),
      text: mtextPlainText(entity.value ?? ""),
      width: entity.rectangleWidth,
      alignment: textAlignment(entity),
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