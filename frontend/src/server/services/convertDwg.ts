import { createDwgReader, type DwgReaderPort, type RawDwgData } from "./dwgReader";
import { parseViews, type ConversionStatistics, type ParsedView } from "./dwgParser";
import { renderToSvg, type RenderOptions } from "./renderer";
import { generatePng, rasterInkFraction } from "./pngGenerator";

import { auditSheetTextCoverage } from "./textCoverage";
import { partitionRenderable, type OmittedSheet } from "./blankSheet";
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
      // The crop shows this many of the model's entities; the parse-time
      // totals are preserved so "skipped" stays honest instead of reading 0.
      totalEntities: model.statistics.totalEntities,
      renderedEntities: cluster.entities.length,
      skippedEntities: model.statistics.skippedEntities,
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
  // A model crop frames the whole drawing, so its labels are always sub-pixel
  // and benefit from extra resolution; layouts are already at true scale and
  // gain nothing but bytes. See `AppConfig.modelPngDimension`.
  const maxDimension = view.isModel ? config.modelPngDimension : config.maxPngDimension;
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
      minTextCapPx: config.minTextCapPx,
      maxTextCapPx: config.maxTextCapPx,
      supersample: supersampleForEntities(view.drawing.entities.length, config.pngSupersample),
      strictTextScale: config.strictTextScale,
    };
    const svg = renderToSvg(view.drawing, options);
    const png = await generatePng(svg, {
      maxWidth: maxDimension,
      maxHeight: maxDimension,
    });
    const renderDurationMs = Date.now() - renderStart;
    logger.info?.(`Rendered SVG and generated PNG (${png.byteLength} bytes) in ${renderDurationMs}ms.`);
    // Opt-in fidelity audit. It answers the question a PNG cannot: did every
    // string this sheet is supposed to show survive into the SVG, and did it
    // survive at a legible size? Cheap next to rendering, so it is left off by
    // default and switched on per deployment.
    if ((process.env.AUDIT_TEXT ?? "").trim() === "1") {
      try {
        const report = auditSheetTextCoverage(view.drawing, svg, {
          sheetName: view.name,
          isModel: view.isModel,
          // With strict scale on there is no floor in the render, so the audit
          // must not judge against one either.
          minCapHeightPx: config.strictTextScale ? 0 : config.minTextCapPx,
        });
        logger.info?.(
          `Text audit "${report.sheet}": ${report.present}/${report.expected} strings` +
            ` (${(report.coverage * 100).toFixed(1)}%), minCap=${report.minCapHeightPx.toFixed(2)}px,` +
            ` belowFloor=${report.belowFloor}, invalid=${report.invalid} -> ${report.ok ? "PASS" : "FAIL"}` +
            (report.missing.length > 0 ? `; missing: ${report.missing.slice(0, 10).join(", ")}` : "")
        );
      } catch (auditErr) {
        logger.info?.(
          `Text audit "${view.name}" failed to run: ${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }`
        );
      }
    }
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
 * sheet → render each to PNG.
 *
 * Two independent blank tests exist for when dropping is enabled
 * (`DROP_BLANK_SHEETS=true`):
 *
 * 1. **It shows a drawing** (`hasSheetDrawing`) — for a layout, model geometry
 *    must land inside one of its viewport windows; for a model crop, the crop
 *    must hold something other than text and points. A layout whose viewport
 *    frames empty model space still renders a full page of title-block ink, so
 *    this is what stops a visually blank sheet from being emitted.
 * 2. **It clears `config.blankSheetInkFraction`** — a sheet can hold geometry
 *    yet still render nearly empty, which is a blank page to a reader.
 *
 * Dropping is off by default, in which case every selected sheet renders and
 * `omittedBlankSheets` is always empty: heuristics must never silently eat a
 * real drawing. A sheet failing either test (when enabled) is never rendered
 * to storage; its name and reason come back in `omittedBlankSheets`. A DWG
 * with more renderable paper-space layouts than `config.maxLayouts` is
 * rejected with MULTIPLE_LAYOUTS, and a DWG whose sheets are *all* blank is
 * rejected with NO_DRAWABLE_CONTENT.
 */
export interface ConvertSummary {
  /** Every sheet that passed both tests, in draw order. */
  sheets: ConversionOutput[];
  /** Every sheet that was dropped, with the reason it was dropped. */
  omittedBlankSheets: OmittedSheet[];
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

  // The unclustered model space is the source of geometry for the viewport
  // test; a layout shows model drawing, never its own neighbours' crops.
  //
  // Blank-sheet dropping is opt-in (DROP_BLANK_SHEETS). By default every
  // selected sheet becomes a PNG: a "blank" heuristic can always be wrong
  // about a real drawing, and a missing PNG is worse than an empty one.
  const modelEntities = inspected.views.find((view) => view.isModel)?.drawing.entities ?? [];
  const { renderable, omitted } = config.dropBlankSheets
    ? partitionRenderable(selected, modelEntities)
    : { renderable: selected, omitted: [] as OmittedSheet[] };
  assertWithinBudget(deadline, "filtering blank sheets");
  if (omitted.length > 0) {
    logger.info?.(
      `Omitted ${omitted.length} sheet(s) showing no drawing: ` +
        omitted.map((sheet) => `"${sheet.name}" (${sheet.reason})`).join(", ") +
        "."
    );
  }

  const sheets: ConversionOutput[] = [];
  for (const [index, view] of renderable.entries()) {
    assertWithinBudget(deadline, `rendering sheet ${index + 1} of ${renderable.length}`);
    const output = await renderViewPng(view, config, logger);
    assertWithinBudget(deadline, `rasterizing sheet ${index + 1} of ${renderable.length}`);
    if (config.dropBlankSheets) {
      const ink = await rasterInkFraction(output.png);
      if (ink < config.blankSheetInkFraction) {
        omitted.push({ name: view.name, reason: "too-little-detail" });
        logger.info?.(
          `Sheet "${view.name}" rendered ${(ink * 100).toFixed(2)}% ink (under ${(
            config.blankSheetInkFraction * 100
          ).toFixed(2)}%); too little detail to be worth a PNG, omitted.`
        );
        continue;
      }
    }
    sheets.push({
      ...output,
      parseDurationMs: inspected.parseDurationMs,
      totalDurationMs: Date.now() - started,
    });
  }

  if (sheets.length === 0) {
    logger.info?.(
      `All ${omitted.length} sheet(s) were blank (${omitted.map((s) => s.name).join(", ") || "none"}).`
    );
    throw new AppError(
      "NO_DRAWABLE_CONTENT",
      `Every sheet in this DWG is blank (${omitted.length} checked).`
    );
  }
  return { sheets, omittedBlankSheets: omitted };
}

function versionFromHeader(raw: { document: { header?: { version?: unknown } | null } }): string | null {
  const version = raw.document.header?.version;
  return typeof version === "string" ? version : null;
}

function colorModeFromEnv(): RenderOptions["colorMode"] {
  return process.env.COLOR_MODE?.toLowerCase() === "color" ? "color" : "monochrome";
}
