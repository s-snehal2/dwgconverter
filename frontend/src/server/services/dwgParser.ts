import { Insert, Viewport, Hatch, Dimension, Leader, Wipeout } from "@node-projects/acad-ts";
import {
  MLine,
  XLine,
  Ray,
  Tolerance,
  Mesh,
  PolygonMesh,
  PolyfaceMesh,
  ModelerGeometry,
  TableEntity,
  MultiLeader,
  Ole2Frame,
  Shape,
  Wall,
  UnderlayEntity,
  AttributeEntity,
} from "@node-projects/acad-ts";
import type { BlockRecord, CadDocument, Layout } from "@node-projects/acad-ts";
import type { RawDwgData } from "./dwgReader";
import { unitsPerMmFrom } from "../utils/lineWeight";
import {
  extractEntity,
  extractHatch,
  extractLeader,
  extractMline,
  extractInfiniteLine,
  extractTolerance,
  extractModelerWires,
  extractMeshFaces,
  extractPolygonMeshFaces,
  extractPolyfaceMeshFaces,
  extractTableEntities,
  extractMultiLeader,
  extractUnderlayFrame,
  extractOleFrame,
  extractWallRect,
  extractShapeMark,
  entityIsVisible,
  normalizeLayer,
} from "./entityExtractor";
import { drawingBounds } from "./boundsCalculator";
import type { Bounds } from "../models/bounds";
import type { Drawing } from "../models/drawing";
import type { Entity } from "../models/entity";
import type { Block } from "../models/block";
import type { Layer } from "../models/layer";
import type { Page, PageViewport } from "../models/page";
import { isUsableViewHeight } from "../models/page";

export interface ConversionStatistics {
  totalEntities: number;
  renderedEntities: number;
  skippedEntities: number;
  warnings: string[];
  /** Present when the drawing has a paper-space page/layout. */
  page?: {
    entityCount: number;
    viewportCount: number;
  };
}

/** One selectable output view: the model space or a named paper-space layout. */
export interface ParsedView {
  /** Stable id, e.g. "model" or "layout-0", recomputed deterministically. */
  viewId: string;
  name: string;
  isModel: boolean;
  drawing: Drawing;
  /**
   * Drawing units per millimetre, from the DWG header (`$INSUNITS`). Paper
   * space shares the drawing's unit, so one value serves every view; it is
   * what turns a physical lineweight in mm into drawing units for the
   * renderer's plot-accurate stroke widths.
   */
  unitsPerMm: number;
  statistics: ConversionStatistics;
}

export interface ViewsResult {
  views: ParsedView[];
  version: string | null;
}

const NON_RENDERABLE_NAMES = new Set([
  "HANDLE",
  "BLOCK_HEADER",
  "SEQEND",
  "VERTEX",
  // ATTRIB_DEF is the unvalued placeholder; ATTRIB (the valued instance) is
  // rendered as TEXT via the TextEntity branch below.
  "ATTRIB_DEF",
  "DIMASSOC",
]);

/**
 * Warning collector that aggregates the common "unsupported entity" noise into
 * one line per distinct type (with a count) so a drawing full of, say, hatches
 * and splines produces a short list instead of a wall of identical messages.
 */
class WarningCollector {
  private readonly unsupported = new Map<string, number>();
  private readonly generic: string[] = [];

  /** Record an unsupported entity type; deduplicated with a running count. */
  addUnsupported(type: string): void {
    const key = type.toUpperCase();
    this.unsupported.set(key, (this.unsupported.get(key) ?? 0) + 1);
  }

  /** Record a one-off, non-repeating warning verbatim. */
  add(message: string): void {
    this.generic.push(message);
  }

  /** The final, deduplicated/aggregated warnings. */
  toArray(): string[] {
    const sorted = [...this.unsupported.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return [
      ...sorted.map(([type, count]) =>
        count > 1
          ? `Unsupported entity "${type}" was skipped (${count} occurrences).`
          : `Unsupported entity "${type}" was skipped.`
      ),
      ...this.generic,
    ];
  }
}

/**
 * Cap on how deeply INSERT/dimension blocks may be expanded. Self-referencing
 * or deeply nested blocks would otherwise recurse until the call stack blows up
 * ("Maximum call stack size exceeded") on otherwise valid DWGs.
 */
const MAX_BLOCK_EXPANSION_DEPTH = 16;

/**
 * Append `items` to `target` without spreading. `Array.prototype.push(...items)`
 * passes every element as a call argument, so a single block/hatch/dimension
 * that expands to tens of thousands of entities blows the V8 argument limit
 * ("Maximum call stack size exceeded" with no recursion in the stack).
 */
function pushAll<T>(target: T[], items: T[]): void {
  for (let i = 0; i < items.length; i += 1) {
    target.push(items[i]);
  }
}

/**
 * Stretch XLINE/RAY unit segments to the sheet they belong to.
 *
 * Infinite construction lines arrive from the extractor as unit direction
 * segments (their true extent is unknowable until every other entity is
 * parsed). Each is re-centered here to span the union bounds of the finite
 * geometry: an XLINE crosses the whole drawing through its own point, a RAY
 * starts at its own point and runs twice the half-diagonal. The direction is
 * preserved, so repeated calls are idempotent. With no finite geometry at all,
 * a fixed fallback keeps the line visible instead of a dot.
 */
export function resolveInfiniteLines(entities: Entity[]): void {
  let dirty = false;
  for (const entity of entities) {
    if (entity.type === "LINE" && (entity.sourceType === "XLINE" || entity.sourceType === "RAY")) {
      dirty = true;
      break;
    }
  }
  if (!dirty) {
    return;
  }
  const finite = entities.filter(
    (entity) => !(entity.type === "LINE" && (entity.sourceType === "XLINE" || entity.sourceType === "RAY"))
  );
  const box = drawingBounds(finite);
  const diagonal = box ? Math.hypot(box.maxX - box.minX, box.maxY - box.minY) : 0;
  const half = diagonal > 1e-9 ? diagonal * 0.75 : 100;
  const cx = box ? (box.minX + box.maxX) / 2 : 0;
  const cy = box ? (box.minY + box.maxY) / 2 : 0;
  for (const entity of entities) {
    if (entity.type !== "LINE" || (entity.sourceType !== "XLINE" && entity.sourceType !== "RAY")) {
      continue;
    }
    const dx = entity.end.x - entity.start.x;
    const dy = entity.end.y - entity.start.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-12)) {
      continue;
    }
    const ux = dx / len;
    const uy = dy / len;
    if (entity.sourceType === "RAY") {
      entity.end = { x: entity.start.x + ux * half * 2, y: entity.start.y + uy * half * 2 };
      continue;
    }
    const t = (cx - entity.start.x) * ux + (cy - entity.start.y) * uy;
    const mx = entity.start.x + ux * t;
    const my = entity.start.y + uy * t;
    entity.start = { x: mx - ux * half, y: my - uy * half };
    entity.end = { x: mx + ux * half, y: my + uy * half };
  }
}

/**
 * Normalize one acad-ts entity (including INSERT expansion) into model entities.
 *
 * `dimensionTextHeight` is forwarded to `extractEntity` and only ever set when
 * recursing through `expandDimensionBlock`; see that function.
 */
function normalizeEntity(
  entity: unknown,
  warnings: WarningCollector,
  depth = 0,
  dimensionTextHeight?: number
): Entity[] {
  if (!entity || typeof (entity as { objectName?: string }).objectName !== "string") {
    warnings.add("Skipped an entity that could not be recognized.");
    return [];
  }
  const acadEntity = entity as Parameters<typeof extractEntity>[0];

  // TableEntity extends Insert, so it must be checked before the INSERT
  // branch: exploding it as a block yields nothing and the whole schedule
  // would vanish.
  if (acadEntity instanceof TableEntity) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const parts = extractTableEntities(acadEntity);
      if (parts.length > 0) {
        return parts;
      }
      warnings.addUnsupported("TABLE");
      return [];
    } catch {
      warnings.add(`Entity "TABLE" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Insert) {
    // Architectural drawings rely on blocks: explode transforms the block
    // entities (scale + rotation + translation) back into world space.
    if (depth >= MAX_BLOCK_EXPANSION_DEPTH) {
      warnings.add("A block was expanded too deeply and was skipped.");
      return [];
    }
    const expanded: Entity[] = [];
    try {
      const transform = acadEntity.getTransform();
      for (const subEntity of acadEntity.explode()) {
        const subName = subEntity.objectName ?? "";
        if (NON_RENDERABLE_NAMES.has(subName)) {
          continue;
        }
        // `Insert.explode()` clones the insert's ATTRIB entities but never runs
        // them through the block transform, so every block attribute would be
        // drawn at the block origin instead of the insert point — usually off
        // the sheet, which reads as missing text. Applying the same transform
        // here puts attribute text back where the DWG placed it.
        if (subEntity instanceof AttributeEntity) {
          subEntity.applyTransform(transform);
        }
        pushAll(expanded, normalizeEntity(subEntity, warnings, depth + 1));
      }
    } catch {
      warnings.add("A block/insert could not be expanded and was skipped.");
    }
    return expanded;
  }

  if (acadEntity instanceof Hatch) {
    // Hatches are decomposed into filled regions (solid) or line segments
    // (pattern) instead of being skipped as unsupported.
    try {
      return extractHatch(acadEntity);
    } catch {
      warnings.add("A hatch could not be processed and was skipped.");
      return [];
    }
  }

  if (acadEntity instanceof Dimension) {
    // Dimensions carry their drawn geometry in an anonymous "*D" block that is
    // already in world coordinates: dimension + extension lines, arrowheads
    // (SOLID/INSERT) and the measured value (MTEXT). Rendering it reproduces
    // what AutoCAD shows. The definition POINTs are grip markers only, so they
    // are dropped.
    return expandDimensionBlock(acadEntity, warnings, depth);
  }

  if (acadEntity instanceof Leader) {
    // Leaders are a path plus an optional arrowhead, both in world coordinates.
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const rendered = extractLeader(acadEntity);
      if (rendered.length > 0) {
        return rendered;
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Wipeout) {
    // A wipeout covers whatever is behind it with the background color. On a
    // white sheet that is invisible, so it is dropped silently.
    return [];
  }

  if (acadEntity instanceof MLine) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const parts = extractMline(acadEntity);
      if (parts.length > 0) {
        return parts;
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof MultiLeader) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const parts = extractMultiLeader(acadEntity);
      if (parts.length > 0) {
        return parts;
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Tolerance) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const parts = extractTolerance(acadEntity);
      if (parts.length > 0) {
        return parts;
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof PolyfaceMesh) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      // A null return means the face indices disagree with the vertex list;
      // fall through to the generic vertex path below rather than inventing
      // faces.
      const faces = extractPolyfaceMeshFaces(acadEntity);
      if (faces) {
        if (faces.length > 0) {
          return faces;
        }
        warnings.addUnsupported(acadEntity.objectName);
        return [];
      }
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof PolygonMesh) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const faces = extractPolygonMeshFaces(acadEntity);
      if (faces) {
        if (faces.length > 0) {
          return faces;
        }
        warnings.addUnsupported(acadEntity.objectName);
        return [];
      }
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Mesh) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const parts = extractMeshFaces(acadEntity);
      if (parts.length > 0) {
        return parts;
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof ModelerGeometry) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const parts = extractModelerWires(acadEntity);
      if (parts.length > 0) {
        return parts;
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Wall) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const rect = extractWallRect(acadEntity);
      if (rect) {
        return [rect];
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Shape) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const mark = extractShapeMark(acadEntity);
      if (mark) {
        warnings.add("A SHAPE glyph has no reconstructible geometry; its insertion point was kept.");
        return [mark];
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof XLine) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const line = extractInfiniteLine(acadEntity, acadEntity.firstPoint, acadEntity.direction, "XLINE");
      if (line) {
        return [line];
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Ray) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const line = extractInfiniteLine(acadEntity, acadEntity.startPoint, acadEntity.direction, "RAY");
      if (line) {
        return [line];
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof Ole2Frame) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const frame = extractOleFrame(acadEntity);
      if (frame) {
        return [frame];
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  if (acadEntity instanceof UnderlayEntity) {
    try {
      if (!entityIsVisible(acadEntity)) {
        return [];
      }
      const frame = extractUnderlayFrame(acadEntity);
      if (frame) {
        return [frame];
      }
      warnings.addUnsupported(acadEntity.objectName);
      return [];
    } catch {
      warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
      return [];
    }
  }

  try {
    if (!entityIsVisible(acadEntity)) {
      return [];
    }
    const normalized = extractEntity(acadEntity, dimensionTextHeight);
    if (normalized) {
      return [normalized];
    }
    warnings.addUnsupported(acadEntity.objectName);
    return [];
  } catch {
    warnings.add(`Entity "${acadEntity.objectName}" could not be processed and was skipped.`);
    return [];
  }
}

/**
 * The text height this dimension's style asks for, in world units.
 *
 * Read straight off the active dimension style (`DIMTXT`), scaled by `DIMSCALE`
 * the same way `extractLeader` scales the arrow size: the scale factor is what
 * makes a drawing-wide dimension style legible on a large sheet, so ignoring it
 * would undo that. Returns undefined when the style cannot be read, which leaves
 * `textEntityHeight` on its generic default.
 */
function dimensionStyleTextHeight(dimension: Dimension): number | undefined {
  try {
    const style = dimension.getActiveDimensionStyle();
    const textHeight = style?.textHeight ?? 0;
    const scale = style?.scaleFactor ?? 0;
    const scaled = textHeight * (scale > 0 ? scale : 1);
    return Number.isFinite(scaled) && scaled > 0 ? scaled : undefined;
  } catch {
    // A dimension whose style is missing or malformed is not worth failing over;
    // the generic text default applies, and the renderer clamps the result.
    return undefined;
  }
}

/** Expand a dimension's anonymous block into its renderable sub-entities. */
function expandDimensionBlock(dimension: Dimension, warnings: WarningCollector, depth = 0): Entity[] {
  const block = dimension.block;
  const blockEntities = block?.entities;
  if (!blockEntities) {
    warnings.addUnsupported("DIMENSION");
    return [];
  }
  if (depth >= MAX_BLOCK_EXPANSION_DEPTH) {
    warnings.add("A dimension's block was expanded too deeply and was skipped.");
    return [];
  }
  const expanded: Entity[] = [];
  let renderedAny = false;
  try {
    for (const subEntity of blockEntities) {
      if (subEntity instanceof Dimension) {
        continue;
      }
      const subName = subEntity.objectName ?? "";
      if (NON_RENDERABLE_NAMES.has(subName) || subName === "POINT") {
        continue;
      }
      // The block's own MTEXT carries the measured value, and its stored height
      // is sometimes 0 — in which case `textEntityHeight` would otherwise land on
      // DEFAULT_TEXT_HEIGHT (1), roughly 5.5x a real dimension label. Hand it the
      // dimension style's height so the fallback stays dimension-sized.
      const part = normalizeEntity(subEntity, warnings, depth + 1, dimensionStyleTextHeight(dimension));
      if (part.length > 0) {
        renderedAny = true;
        // Stamp the dimension origin onto everything the block contributed.
        // It has to be done here, after normalization: the block is flattened
        // into ordinary LINE / MTEXT / SOLID entities, so by the time this
        // returns there is no longer a Dimension to ask, and the measured value
        // in particular arrives looking like any other MTEXT.
        for (const entity of part) {
          entity.fromDimension = true;
        }
        pushAll(expanded, part);
      }
    }
  } catch {
    warnings.add("A dimension's block could not be expanded and was skipped.");
    return [];
  }
  if (!renderedAny) {
    warnings.addUnsupported("DIMENSION");
    return [];
  }
  return expanded;
}

/** Convert one acad-ts paper-space Viewport into our page-window model. */
function pageViewportFromAcad(entity: Viewport): PageViewport | null {
  // id === 1 is the layout's own "paper view" (the backdrop of the whole
  // sheet), not a window onto the model; anything without a real frame or an
  // empty model window cannot be projected either.
  if (entity.representsPaper) {
    return null;
  }
  if (entity.width <= 0 || entity.height <= 0 || !isUsableViewHeight(entity.viewHeight)) {
    return null;
  }
  const halfW = entity.width / 2;
  const halfH = entity.height / 2;
  return {
    minX: entity.center.x - halfW,
    minY: entity.center.y - halfH,
    maxX: entity.center.x + halfW,
    maxY: entity.center.y + halfH,
    centerX: entity.center.x,
    centerY: entity.center.y,
    width: entity.width,
    height: entity.height,
    viewCenterX: entity.viewCenter.x,
    viewCenterY: entity.viewCenter.y,
    viewWidth: entity.viewWidth,
    viewHeight: entity.viewHeight,
    twist: entity.twistAngle ?? 0,
    frozenLayers: entity.frozenLayers?.map((layer) => layer.name).filter(Boolean) ?? [],
  };
}

/** Union of an initial bounds with a viewport rectangle. */
function includeRect(acc: { minX: number; minY: number; maxX: number; maxY: number } | null, minX: number, minY: number, maxX: number, maxY: number) {
  if (acc === null) {
    return { minX, minY, maxX, maxY };
  }
  return {
    minX: Math.min(acc.minX, minX),
    minY: Math.min(acc.minY, minY),
    maxX: Math.max(acc.maxX, maxX),
    maxY: Math.max(acc.maxY, maxY),
  };
}

/**
 * Extract the paper-space page from one block record: the sheet entities
 * (border, title block, notes) plus the viewport windows that frame what the
 * drawing looks like at "full page size". Returns null when the record has no
 * usable content.
 */
function pageFromBlockRecord(blockRecord: BlockRecord | null, warnings: WarningCollector): Page | null {
  if (!blockRecord?.entities) {
    return null;
  }

  const pageEntities: Entity[] = [];
  const pageViewports: PageViewport[] = [];
  for (const entity of blockRecord.entities) {
    if (entity instanceof Viewport) {
      const viewport = pageViewportFromAcad(entity);
      if (viewport) {
        pageViewports.push(viewport);
      }
      continue;
    }
    pushAll(pageEntities, normalizeEntity(entity, warnings));
  }
  resolveInfiniteLines(pageEntities);

  let bounds = drawingBounds(pageEntities);
  for (const viewport of pageViewports) {
    bounds = includeRect(bounds, viewport.minX, viewport.minY, viewport.maxX, viewport.maxY);
  }

  if (bounds === null || (pageEntities.length === 0 && pageViewports.length === 0)) {
    return null;
  }
  if (
    !Number.isFinite(bounds.maxX - bounds.minX) ||
    !Number.isFinite(bounds.maxY - bounds.minY) ||
    bounds.maxX < bounds.minX ||
    bounds.maxY < bounds.minY
  ) {
    return null;
  }

  return { entities: pageEntities, viewports: pageViewports, bounds };
}

function normalizeLayers(document: CadDocument): Layer[] {
  const layers: Layer[] = [];
  if (document.layers) {
    for (const layer of document.layers) {
      layers.push(normalizeLayer(layer));
    }
  }
  return layers;
}

interface NormalizedModel {
  entities: Entity[];
  total: number;
  rendered: number;
}

function normalizeModelSpace(document: CadDocument, warnings: WarningCollector): NormalizedModel {
  const entities: Entity[] = [];
  let total = 0;
  let rendered = 0;

  if (document.modelSpace?.entities) {
    for (const entity of document.modelSpace.entities) {
      total += 1;
      const normalized = normalizeEntity(entity, warnings);
      if (normalized.length > 0) {
        rendered += 1;
      }
      pushAll(entities, normalized);
    }
  }
  resolveInfiniteLines(entities);
  return { entities, total, rendered };
}

function viewStatistics(total: number, rendered: number, warnings: WarningCollector): ConversionStatistics {
  return {
    totalEntities: total,
    renderedEntities: rendered,
    skippedEntities: total - rendered,
    warnings: warnings.toArray(),
  };
}

/**
 * Plausibility window for a paper rectangle against the content it holds.
 *
 * Layout media settings are unreliable: real drawings claim 210×297 for a
 * sheet whose title block is 17.5×11.6 units, mix millimetre and inch numbers
 * within one file, and store a rotation on top. A paper rectangle is only
 * trusted when it is the same order of magnitude as the sheet's own content —
 * outside this window the claim is wrong and the content bounds stand alone.
 */
const PAPER_RATIO_MIN = 0.3;
const PAPER_RATIO_MAX = 3;

/**
 * The layout's paper rectangle in paper-space drawing units, anchored at the
 * origin, or null when the media claim is not credible for this content.
 *
 * Unit candidates: `paperWidth`/`paperHeight` come in `paperUnits`
 * (inches/mm/pixels), but paper-space coordinates follow the drawing, which
 * may be either — so both readings are tried, in the order the setting
 * implies, and the first that fits the content wins. A 90°/270° plot rotation
 * turns the media the way AutoCAD shows it, which swaps width and height.
 */
function layoutPaperBounds(layout: Layout, content: Bounds): Bounds | null {
  let width = layout.paperWidth;
  let height = layout.paperHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const rotation = Number(layout.paperRotation) || 0;
  if (rotation === 1 || rotation === 3) {
    const swap = width;
    width = height;
    height = swap;
  }
  // 1 = Millimeters, 0 = Inches (PlotPaperUnits); anything else is skipped.
  const unitScales =
    layout.paperUnits === 1 ? [1, 1 / 25.4, 25.4] : layout.paperUnits === 0 ? [1, 25.4, 1 / 25.4] : null;
  const span = Math.max(content.maxX - content.minX, content.maxY - content.minY);
  if (!unitScales || !Number.isFinite(span) || span <= 0) {
    return null;
  }
  for (const scale of unitScales) {
    const w = width * scale;
    const h = height * scale;
    const ratio = Math.max(w, h) / span;
    if (Number.isFinite(ratio) && ratio >= PAPER_RATIO_MIN && ratio <= PAPER_RATIO_MAX) {
      return { minX: 0, minY: 0, maxX: w, maxY: h };
    }
  }
  return null;
}

/**
 * Union the layout's own paper rectangle into the sheet bounds.
 *
 * One layout becomes one PNG of the real sheet: at least the paper AutoCAD
 * would plot onto, framed from the origin. Unioning — never replacing — is the
 * point: content that spills past the media edge stays visible instead of
 * being cropped away, while a sparse sheet still gets its paper bounds rather
 * than shrinking to whatever ink happens to exist.
 */
function includeLayoutPaper(page: Page, layout: Layout): void {
  const paper = layoutPaperBounds(layout, page.bounds);
  if (!paper) {
    return;
  }
  page.bounds = includeRect(page.bounds, paper.minX, paper.minY, paper.maxX, paper.maxY);
}

/**
 * Enumerate the paper-space layouts as selectable views. Names come from the
 * DWG's ACAD_LAYOUT table (e.g. "Model 1", "Model 2"); each sheet is the
 * border/title block plus the viewport windows onto the model. Layouts without
 * renderable content are skipped. When no layout table exists (older writers),
 * falls back to the single legacy *Paper_Space block.
 */
function paperSpaceViews(
  document: CadDocument,
  warnings: WarningCollector,
  model: NormalizedModel,
  layers: Layer[],
  blocks: Block[],
  unitsPerMm: number
): ParsedView[] {
  const views: ParsedView[] = [];
  const layouts: Layout[] = document.layouts
    ? Array.from(document.layouts).sort((a, b) => a.tabOrder - b.tabOrder)
    : [];

  if (layouts.length > 0) {
    let seen = 0;
    for (const layout of layouts) {
      if (!layout.isPaperSpace) {
        continue; // the "Model" layout is handled as the model view.
      }
      const page = pageFromBlockRecord(layout.associatedBlock, warnings);
      if (!page) {
        continue;
      }
      includeLayoutPaper(page, layout);
      views.push({
        viewId: `layout-${seen}`,
        name: layout.name,
        isModel: false,
        drawing: { entities: model.entities, bounds: page.bounds, layers, blocks, page },
        unitsPerMm,
        statistics: {
          ...viewStatistics(model.total, model.rendered, warnings),
          page: { entityCount: page.entities.length, viewportCount: page.viewports.length },
        },
      });
      seen += 1;
    }
    return views;
  }

  // Legacy DWGs with no layout table: surface the single paper-space block.
  const page = pageFromBlockRecord(document.paperSpace, warnings);
  if (page) {
    views.push({
      viewId: "layout",
      name: legacyPaperName(document) ?? "Layout 1",
      isModel: false,
      drawing: { entities: model.entities, bounds: page.bounds, layers, blocks, page },
      unitsPerMm,
      statistics: {
        ...viewStatistics(model.total, model.rendered, warnings),
        page: { entityCount: page.entities.length, viewportCount: page.viewports.length },
      },
    });
  }
  return views;
}

function legacyPaperName(document: CadDocument): string | null {
  if (!document.layouts) {
    return null;
  }
  for (const layout of document.layouts) {
    if (layout.associatedBlock === document.paperSpace) {
      return layout.name;
    }
  }
  return null;
}

/**
 * Enumerate every renderable view in the DWG in draw order: the model space
 * first (when it has content), then each named paper-space layout that has
 * renderable content.
 */
export function parseViews(raw: RawDwgData): ViewsResult {
  const document = raw.document;
  const warnings = new WarningCollector();
  const layers = normalizeLayers(document);
  // Blocks are not consumed by the renderer; normalizing every named block in
  // the table (many never-inserted) would waste CPU and memory on big DWGs.
  const blocks: Block[] = [];
  const model = normalizeModelSpace(document, warnings);
  const modelBounds = drawingBounds(model.entities);
  const unitsPerMm = unitsPerMmFrom(document.header?.insUnits, document.header?.measurementUnits);

  const views: ParsedView[] = [];
  if (modelBounds) {
    views.push({
      viewId: "model",
      name: "Model",
      isModel: true,
      drawing: { bounds: modelBounds, entities: model.entities, layers, blocks },
      unitsPerMm,
      statistics: viewStatistics(model.total, model.rendered, warnings),
    });
  }
  pushAll(views, paperSpaceViews(document, warnings, model, layers, blocks, unitsPerMm));

  if (views.length === 0) {
    throw new Error("No drawable model space content was found in this drawing.");
  }
  return { views, version: raw.version ?? null };
}
