export interface ConversionStatistics {
  totalEntities: number;
  renderedEntities: number;
  skippedEntities: number;
  warnings: string[];
}

export interface ConversionResult {
  success: boolean;
  conversionId: string;
  originalFileName: string;
  /** The human-friendly output filename (e.g. "drawing-FLOORING LAYOUT.png"). */
  fileName: string;
  /** The sheet/layout name this PNG was rendered from (e.g. "FLOORING LAYOUT"). */
  sheetName?: string;
  /** Stable view id: "model" or "layout". */
  viewId?: string;
  /** PNG size in bytes. */
  size: number;
  version: string | null;
  statistics: ConversionStatistics;
  warnings: string[];
  durationMs?: number;
}

/**
 * Why a sheet produced no PNG:
 * - `no-drawing`: nothing was drawn inside the layout's viewport window, or a
 *   model crop held only text/points, so the page would be empty of content.
 * - `too-little-detail`: the sheet did show geometry, but its rendered PNG fell
 *   under the blank-ink threshold, so it would still read as blank.
 */
export type BlankSheetReason = "no-drawing" | "too-little-detail";

export interface OmittedSheet {
  /** Display name of the dropped sheet (e.g. "Layout 2", "Model 3"). */
  name: string;
  reason: BlankSheetReason;
}

/** One DWG upload converted into one PNG per paper-space layout sheet. */
export interface MultiSheetResult {
  success: boolean;
  originalFileName: string;
  sheetCount: number;
  /** Sheets that produced no PNG, with the reason each was dropped. */
  omittedBlankSheets?: OmittedSheet[];
  sheets: ConversionResult[];
  version: string | null;
  durationMs?: number;
}

export interface ConversionError {
  success: false;
  error: string;
}

/**
 * Where the returned AI image came from:
 * - `generated`: Gemini produced a fresh image for this request.
 * - `cached-pair`: an earlier image for the same sheet, prompt and PNG bytes,
 *   replayed from the AI pair cache without a Gemini call.
 */
export type AiImageSource = "generated" | "cached-pair";

export interface AiImageResult {
  success: boolean;
  conversionId: string;
  fileName: string;
  size: number;
  durationMs: number;
  /** AI generations used for this conversion after this request. */
  generationsUsed: number;
  /** Maximum AI generations allowed per conversion. */
  generationsLimit: number;
  /**
   * True when the server replayed an earlier image from the AI pair cache
   * instead of calling Gemini. Such a replay consumes no generation and reports
   * `durationMs: 0`.
   */
  cached?: boolean;
  source?: AiImageSource;
  /**
   * True when the served image came from the pair cache. The drawing already has
   * an AI image for 30 days, so the UI must stop offering further generations
   * rather than spending another one.
   */
  blocked?: boolean;
  createdAt?: number;
  /** Echoed back when this request was an explicit regeneration. */
  regenerate?: boolean;
  /** sha256 of the source DWG this drawing belongs to. */
  sourceHash?: string;
}

export interface TilesviewResult {
  success: boolean;
  conversionId: string;
  customRoomsId: number;
  /** Full URL of the created room in the TilesView visualizer. */
  visualizerUrl: string;
}
