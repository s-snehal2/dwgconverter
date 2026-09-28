import { Insert, Viewport, Hatch, Dimension, Leader, Wipeout } from "@node-projects/acad-ts";
import type { BlockRecord, CadDocument, Layout } from "@node-projects/acad-ts";
import type { RawDwgData } from "./dwgReader";
import { extractEntity, extractHatch, extractLeader, entityIsVisible, normalizeLayer } from "./entityExtractor";
import { drawingBounds } from "./boundsCalculator";
import type { Drawing } from "../models/drawing";
import type { Entity } from "../models/entity";
import type { Block } from "../models/block";
import type { Layer } from "../models/layer";
import type { Page, PageViewport } from "../models/page";

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

export interface ParsedDrawing {
  drawing: Drawing;
  statistics: ConversionStatistics;
  version: string | null;
}

/** One selectable output view: the model space or a named paper-space layout. */
export interface ParsedView {
  /** Stable id, e.g. "model" or "layout-0", recomputed deterministically. */
  viewId: string;
  name: string;
  isModel: boolean;
  drawing: Drawing;
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
  "ATTRIB",
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

/** Normalize one acad-ts entity (including INSERT expansion) into model entities. */
function normalizeEntity(
  entity: unknown,
  warnings: WarningCollector,
  depth = 0
): Entity[] {
  if (!entity || typeof (entity as { objectName?: string }).objectName !== "string") {
    warnings.add("Skipped an entity that could not be recognized.");
    return [];
  }
  const acadEntity = entity as Parameters<typeof extractEntity>[0];

  if (acadEntity instanceof Insert) {
    // Architectural drawings rely on blocks: explode transforms the block
    // entities (scale + rotation + translation) back into world space.
    if (depth >= MAX_BLOCK_EXPANSION_DEPTH) {
      warnings.add("A block was expanded too deeply and was skipped.");
      return [];
    }
    const expanded: Entity[] = [];
    try {
      for (const subEntity of acadEntity.explode()) {
        const subName = subEntity.objectName ?? "";
        if (NON_RENDERABLE_NAMES.has(subName)) {
          continue;
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

  try {
    if (!entityIsVisible(acadEntity)) {
      return [];
    }
    const normalized = extractEntity(acadEntity);
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
      const part = normalizeEntity(subEntity, warnings, depth + 1);
      if (part.length > 0) {
        renderedAny = true;
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
  if (entity.width <= 0 || entity.height <= 0 || entity.viewHeight <= 0) {
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

/** The legacy convenience page: the DWG's single paper-space block record. */
function extractPage(document: CadDocument, warnings: WarningCollector): Page | null {
  return pageFromBlockRecord(document.paperSpace, warnings);
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
  blocks: Block[]
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
      views.push({
        viewId: `layout-${seen}`,
        name: layout.name,
        isModel: false,
        drawing: { entities: model.entities, bounds: page.bounds, layers, blocks, page },
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

  const views: ParsedView[] = [];
  if (modelBounds) {
    views.push({
      viewId: "model",
      name: "Model",
      isModel: true,
      drawing: { bounds: modelBounds, entities: model.entities, layers, blocks },
      statistics: viewStatistics(model.total, model.rendered, warnings),
    });
  }
  pushAll(views, paperSpaceViews(document, warnings, model, layers, blocks));

  if (views.length === 0) {
    throw new Error("No drawable model space content was found in this drawing.");
  }
  return { views, version: raw.version ?? null };
}

/** Convert a DWG into the single normalized drawing (legacy pipeline entry). */
export function parseDwg(raw: RawDwgData): ParsedDrawing {
  const document = raw.document;
  const warnings = new WarningCollector();
  const layers = normalizeLayers(document);
  const blocks: Block[] = [];
  const model = normalizeModelSpace(document, warnings);
  const page = extractPage(document, warnings);

  const bounds = drawingBounds(model.entities);
  if (!bounds && !page) {
    throw new Error("No drawable model space content was found in this drawing.");
  }

  return {
    drawing: {
      bounds: bounds ?? page!.bounds,
      entities: model.entities,
      layers,
      blocks,
      page: page ?? undefined,
    },
    statistics: {
      ...viewStatistics(model.total, model.rendered, warnings),
      ...(page ? { page: { entityCount: page.entities.length, viewportCount: page.viewports.length } } : {}),
    },
    version: raw.version ?? null,
  };
}