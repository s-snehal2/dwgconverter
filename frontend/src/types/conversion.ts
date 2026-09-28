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

/** One DWG upload converted into one PNG per paper-space layout sheet. */
export interface MultiSheetResult {
  success: boolean;
  originalFileName: string;
  sheetCount: number;
  /** Names of sheets omitted because they rendered blank. */
  skippedBlankSheets?: string[];
  sheets: ConversionResult[];
  version: string | null;
  durationMs?: number;
}

export interface ConversionError {
  success: false;
  error: string;
}

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
}

export interface TilesviewResult {
  success: boolean;
  conversionId: string;
  customRoomsId: number;
  /** Full URL of the created room in the TilesView visualizer. */
  visualizerUrl: string;
}
