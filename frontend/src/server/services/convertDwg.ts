import { createDwgReader, type DwgReaderPort, type RawDwgData } from "./dwgReader";
import { parseViews, type ConversionStatistics, type ParsedView } from "./dwgParser";
import { renderToSvg, type RenderOptions } from "./renderer";
import { generatePng, rasterInkFraction } from "./pngGenerator";
import {
  clusterModelEntities,
  limitClusters,
  DEFAULT_CLUSTER_OPTIONS,
  type ClusterOptions,
} from "./modelClusterer";
import { AppError } from "../utils/errors";
import type { AppConfig } from "../config";
import { validateDwgSignature } from "../utils/fileValidation";

/**
 * Views with more normalized entities than this skip the upsample oversample on
 * the full render: a 6000px canvas with tens of thousands of entities (dims,
 * hatches, insert explosions) is disproportionately slow, so huge drawings
 * render at exact size instead.
 */
const HUGE_ENTITY_SUPERSAMPLE_THRESHOLD = 15000;

/** Oversample factor to use for a full render of a view with this many entities. */
export function supersampleForEntities(entityCount: number, configured: number): number {
  return entityCount >= HUGE_ENTITY_SUPERSAMPLE_THRESHOLD ? 1 : configured;
}

export interface ConversionOutput {
  png: Buffer;
  statistics: ConversionStatistics;
  version: string | null;
  totalDurationMs: number;
  parseDurationMs: number;
  renderDurationMs: number;
  /** Display name of the rendered sheet (e.g. "FLOORING LAYOUT"). */
  viewName: string;
  /** True when this output is the raw model space. */
  isModel: boolean;
}

export interface ConversionLogger {
  info?: (message: string) => void;
}

/**
 * Throws when a conversion has run past its wall-clock budget.
 *
 * The platform kills a function at `maxDuration` with an opaque 504 before any
 * JavaScript can respond, so the budget is checked between stages to fail early
 * with a message a user can act on. The parse itself is a single blocking call
 * and cannot be interrupted; this catches the long tail, where a large drawing
 * would otherwise time out several minutes in.
 */
function assertWithinBudget(deadline: number, stage: string): void {
  if (Date.now() > deadline) {
    throw new AppError(
      "CONVERSION_TIMEOUT",
      `Conversion exceeded its time budget during ${stage}.`
    );
  }
}

/** A parsed, render-ready view (model space or a paper-space layout). */
export type InspectedView = ParsedView & { version: string | null };

export interface InspectViewsResult {
  version: string | null;
  views: InspectedView[];
  parseDurationMs: number;
}

/**
 * Expand the model-space view into one view per drawing cluster, so each
 * cluster renders as its own tightly-fitted (and therefore zoomed) PNG.
 * Cluster bounds drive `computeViewport`, which already fits any bounds to the
 * full canvas, so the crop is all the zoom that is needed.
 *
 * Clusters beyond `budget` are merged into their nearest neighbour rather than
 * dropped, so capping output only coarsens crops and never loses entities.
 */
function expandModelView(
  model: InspectedView,
  clusterOptions: ClusterOptions,
  budget: number
): InspectedView[] {
  if (budget <= 0) {
    return [];
  }
  const clusters = limitClusters(
    clusterModelEntities(model.drawing.entities, clusterOptions),
    budget
  );
  // A model view exists only when it has entities, so an empty result means
  // every entity was unmeasurable. Keep the unclustered view rather than
  // silently returning nothing to render.
  if (clusters.length === 0) {
    return [model];
  }
  return clusters.map((cluster, index) => ({
    ...model,
    viewId: `model-${index}`,
    name: index === 0 ? "Model" : `Model ${index + 1}`,
    drawing: { ...model.drawing, entities: cluster.entities, bounds: cluster.bounds },
    statistics: {
      ...model.statistics,
      totalEntities: cluster.entities.length,
      renderedEntities: cluster.entities.length,
      skippedEntities: 0,
    },
  }));
}

/**
 * Select every sheet to convert, in draw order: each paper-space layout
 * followed by the model-space clusters. A DWG with more paper-space layouts
 * than `maxLayouts` is rejected with MULTIPLE_LAYOUTS so a degenerate file
 * cannot trigger an unbounded chain of renders; model clusters are instead
 * merged down to whatever budget the layouts leave behind, since coarsening
 * crops loses no drawing content.
 */
export function selectViewsForConversion(
  views: InspectedView[],
  maxLayouts = 100,
  clusterOptions: ClusterOptions = DEFAULT_CLUSTER_OPTIONS
): InspectedView[] {
  if (views.length === 0) {
    throw new AppError("NO_DRAWABLE_CONTENT", "No drawable content was found in this DWG file.");
  }
  const layouts = views.filter((view) => !view.isModel);
  if (layouts.length > maxLayouts) {
    throw new AppError(
      "MULTIPLE_LAYOUTS",
      `The DWG contains ${layouts.length} layout sheets; a maximum of ${maxLayouts} is supported.`
    );
  }
  const model = views.find((view) => view.isModel);
  const modelViews = model
    ? expandModelView(model, clusterOptions, maxLayouts - layouts.length)
    : [];
  return [...layouts, ...modelViews];
}

/**
 * Select the single drawable page for a one-shot conversion: the first
 * paper-space layout, else the raw model space.
 */
export function selectViewForConversion(views: InspectedView[], maxLayouts = 1): InspectedView {
  return selectViewsForConversion(views, maxLayouts)[0];
}

/**
 * Validate a DWG payload, read it and enumerate every renderable view.
 * Never touches the disk — pure in-memory inspection so the caller can decide
 * what to do with the parse results.
 */
export async function inspectDwg(
  arrayBuffer: ArrayBuffer,
  logger: ConversionLogger = {},
  overrides?: DwgReaderPort
): Promise<InspectViewsResult> {
  const parseStart = Date.now();
  const reader = overrides ?? createDwgReader();

  const signature = validateDwgSignature(new Uint8Array(arrayBuffer, 0, 6));
  if (!signature.ok) {
    throw signature.error;
  }
  if (arrayBuffer.byteLength < 8) {
    throw new AppError("INVALID_FILE", "The uploaded file is too short to be a DWG file.");
  }

  let raw: RawDwgData;
  try {
    raw = reader.read(arrayBuffer);
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    logger.info?.(`Parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError("PARSER_ERROR", err instanceof Error ? err.message : String(err));
  }

  let views: ParsedView[];
  try {
    views = parseViews(raw).views;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError("PARSER_ERROR", err instanceof Error ? err.message : String(err));
  }

  const version = raw.version ?? versionFromHeader(raw);
  return {
    version,
    views: views.map((view) => ({ ...view, version })),
    parseDurationMs: Date.now() - parseStart,
  };
}

/**
 * Render one already-inspected view to a full-size PNG (supersampled, then
 * downscaled to fit the configured maximum dimension).
 */
export async function renderViewPng(
  view: InspectedView,
  config: AppConfig,
  logger: ConversionLogger = {}
): Promise<ConversionOutput> {
  const started = Date.now();
  const renderStart = Date.now();
  const maxDimension = config.maxPngDimension;
  logger.info?.(
    `Rendering view "${view.name}"${view.isModel ? "" : " (layout)"} at up to ${maxDimension}px.`
  );

  try {
    const options: RenderOptions = {
      colorMode: colorModeFromEnv(),
      maxWidth: maxDimension,
      maxHeight: maxDimension,
      margin: config.marginPx,
      minStrokePx: config.minStrokePx,
      supersample: supersampleForEntities(view.drawing.entities.length, config.pngSupersample),
    };
    const svg = renderToSvg(view.drawing, options);
    const png = await generatePng(svg, {
      maxWidth: maxDimension,
      maxHeight: maxDimension,
    });
    const renderDurationMs = Date.now() - renderStart;
    logger.info?.(`Rendered SVG and generated PNG (${png.byteLength} bytes) in ${renderDurationMs}ms.`);
    return {
      png,
      statistics: view.statistics,
      version: view.version,
      totalDurationMs: Date.now() - started,
      parseDurationMs: 0,
      renderDurationMs,
      viewName: view.name,
      isModel: view.isModel,
    };
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    logger.info?.(`Rendering failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new AppError("RENDER_ERROR", err instanceof Error ? err.message : String(err));
  }
}

/**
 * The multi-sheet conversion orchestrator: inspect → select every drawable
 * sheet → render each to a PNG. A sheet whose PNG is effectively empty is
 * dropped rather than emitted, so callers never receive a blank page; the names
 * of dropped sheets come back in `skippedBlankSheets`. A DWG with more
 * renderable paper-space layouts than `config.maxLayouts` is rejected with
 * MULTIPLE_LAYOUTS, and a DWG whose sheets are *all* blank is rejected with
 * NO_DRAWABLE_CONTENT.
 */
export interface ConvertSummary {
  /** Every non-blank sheet, in draw order. One entry per renderable layout. */
  sheets: ConversionOutput[];
  /**
   * Names of sheets whose rendered PNG was blank and therefore omitted. These
   * are absent from `sheets` and are never persisted.
   */
  skippedBlankSheets: string[];
}

export async function convertDwg(
  arrayBuffer: ArrayBuffer,
  config: AppConfig,
  logger: ConversionLogger = {},
  overrides?: DwgReaderPort
): Promise<ConvertSummary> {
  const started = Date.now();
  const deadline = started + Math.max(1, config.conversionBudgetMs);
  logger.info?.(`Conversion started (${arrayBuffer.byteLength} bytes received).`);

  const inspected = await inspectDwg(arrayBuffer, logger, overrides);
  assertWithinBudget(deadline, "parsing");
  const selected = selectViewsForConversion(inspected.views, config.maxLayouts, {
    gapFraction: config.modelClusterGapFraction,
    maxDepth: config.modelClusterMaxDepth,
    minEntities: DEFAULT_CLUSTER_OPTIONS.minEntities,
  });
  const modelCount = selected.filter((view) => view.isModel).length;
  logger.info?.(
    `Parsed DWG${inspected.version ? ` (${inspected.version})` : ""}: ${selected.length} sheet(s) to consider` +
      ` (${selected.length - modelCount} layout(s), ${modelCount} model crop(s)).`
  );

  const skippedBlankSheets: string[] = [];
  const sheets: ConversionOutput[] = [];
  for (const [index, view] of selected.entries()) {
    assertWithinBudget(deadline, `rendering sheet ${index + 1} of ${selected.length}`);
    const output = await renderViewPng(view, config, logger);
    assertWithinBudget(deadline, `rasterizing sheet ${index + 1} of ${selected.length}`);
    const ink = await rasterInkFraction(output.png);
    if (ink < config.blankSheetInkFraction) {
      skippedBlankSheets.push(view.name);
      logger.info?.(
        `Sheet "${view.name}" rendered ${(ink * 100).toFixed(2)}% ink (under ${(
          config.blankSheetInkFraction * 100
        ).toFixed(2)}%); blank, omitted.`
      );
      continue;
    }
    sheets.push({
      ...output,
      parseDurationMs: inspected.parseDurationMs,
      totalDurationMs: Date.now() - started,
    });
  }

  if (sheets.length === 0) {
    const names = skippedBlankSheets.join(", ");
    logger.info?.(`All ${skippedBlankSheets.length} sheet(s) were blank (${names || "none"}).`);
    throw new AppError(
      "NO_DRAWABLE_CONTENT",
      `Every sheet in this DWG is blank (${skippedBlankSheets.length} checked).`
    );
  }
  if (skippedBlankSheets.length > 0) {
    logger.info?.(
      `Omitted ${skippedBlankSheets.length} blank sheet(s): ${skippedBlankSheets.join(", ")}.`
    );
  }
  return { sheets, skippedBlankSheets };
}

function versionFromHeader(raw: { document: { header?: { version?: unknown } | null } }): string | null {
  const version = raw.document.header?.version;
  return typeof version === "string" ? version : null;
}

function colorModeFromEnv(): RenderOptions["colorMode"] {
  return process.env.COLOR_MODE?.toLowerCase() === "color" ? "color" : "monochrome";
}
