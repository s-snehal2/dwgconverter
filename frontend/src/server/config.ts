import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MAX_TEXT_CAP_PX, DEFAULT_MIN_TEXT_CAP_PX } from "./services/textMetrics";

export interface AppConfig {
  maxFileSizeBytes: number;
  /**
   * Wall-clock budget for one conversion, in ms. The platform kills the
   * function at `maxDuration` (300s) with an opaque 504 before any JavaScript
   * can respond, so the budget is set below that and checked between stages to
   * return a real error instead.
   */
  conversionBudgetMs: number;
  maxPngDimension: number;
  /**
   * Output size for model-space crops, which default to the same size as a
   * layout sheet.
   *
   * A whole-model crop is the one view whose labels are always sub-pixel: it
   * frames the entire drawing, so millimetre annotation scales to a small
   * fraction of a pixel and the text legibility floor has to inflate it heavily.
   * Measured on a real drawing, raising only the model crops to 6000px cut that
   * inflation from 47x to 13x while the 26 layout sheets — already at true scale —
   * stayed at 3000px, which is roughly 1/12th of the PNG bytes.
   */
  modelPngDimension: number;
  marginPx: number;
  /** Oversample factor for anti-aliasing (2 = render at 2x, downscale to fit). */
  pngSupersample: number;
  /** Minimum stroke thickness in pixels, so thin CAD lines stay visible. */
  minStrokePx: number;
  /**
   * Smallest cap height, in output pixels, any label is drawn at. Annotation on
   * a large sheet is only millimetres tall and scales to a fraction of a pixel,
   * so this floor is what keeps text legible in the PNG at all.
   */
  minTextCapPx: number;
  /**
   * Largest cap height, in output pixels, any label is drawn at. The counterpart
   * to `minTextCapPx`, and the one that matters when strict scale is on: with no
   * floor in play, text size is exactly `entity.height × scale` and nothing
   * upstream bounds it, so a single mis-scaled height renders as type tens of
   * times larger than the sheet.
   */
  maxTextCapPx: number;
  /**
   * Draw labels at their true DWG size rather than enforcing `minTextCapPx`.
   *
   * True by default. The floor is a real distortion — it inflates sub-pixel
   * annotations into labels the source drawing does not contain — so it is
   * opt-in. `maxTextCapPx` still applies either way: strict mode has no floor,
   * so it needs a ceiling.
   */
  strictTextScale: boolean;
  /** Maximum number of paper-space layout sheets converted per DWG. */
  maxLayouts: number;
  /**
   * Drop sheets that show no drawing (or almost no ink) instead of emitting a
   * PNG for them. Off by default: every layout and every model crop becomes a
   * PNG, so no drawing content can ever be silently lost. Enable only to keep
   * mostly-empty sheets out of the results.
   */
  dropBlankSheets: boolean;
  /**
   * Rendered ink coverage below which a sheet is treated as blank and dropped
   * instead of being emitted as a mostly-empty PNG. Measured by
   * `rasterInkFraction`, so 0.005 means "less than half a percent of the page
   * is covered in drawn lines".
   */
  blankSheetInkFraction: number;
  /**
   * Fraction of an axis span that must be empty before model space is cut into
   * a separate per-drawing crop. Larger means fewer, bigger crops.
   */
  modelClusterGapFraction: number;
  /** Recursion ceiling for model-space clustering. */
  modelClusterMaxDepth: number;
  cleanupAgeMs: number;
  /**
   * How long a staged inbound DWG may linger before the sweep reclaims it.
   * Uploads are deleted as soon as a conversion finishes; this only bounds the
   * damage from a crashed or timed-out conversion that never reached cleanup.
   */
  uploadAgeMs: number;
  tempRootDir: string;
  outputsDir: string;
  /** How long a cached AI image is kept before reuse stops (30 days default). */
  cacheAgeMs: number;
  rateLimitMax: number;
  /** Gemini API key for AI image generation (empty = AI features disabled). */
  geminiApiKey: string;
  /** User-visible static prompt sent to Gemini alongside the DWG PNG. */
  geminiPrompt: string;
  /** Gemini image-generation model id (Nano Banana 2). */
  geminiModel: string;
  /** Max successful AI image generations per conversion; 0 = unlimited. */
  aiGenerationLimit: number;
  /** Max time Gemini has to produce an image, in milliseconds. */
  geminiTimeoutMs: number;
  /** TilesView room-planner API endpoint. */
  tilesviewApiUrl: string;
  /** TilesView app key (empty = TilesView integration disabled). */
  tilesviewAppKey: string;
  /** TilesView app secret (empty = TilesView integration disabled). */
  tilesviewAppSecret: string;
  /** Header name for the TilesView app key (default "app_key"). */
  tilesviewAppKeyHeader: string;
  /** Header name for the TilesView app secret (default "app_secret"). */
  tilesviewAppSecretHeader: string;
  /** Base URL of the TilesView visualizer app (without trailing slash). */
  tilesviewVisualizerBaseUrl: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like `parsePositiveInt`, but `0` is a valid value rather than a fallback trigger. */
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTempRoot(): string {
  if (process.env.TEMP_DIR) {
    return resolve(process.env.TEMP_DIR);
  }
  // Serverless bundles run with cwd set to the read-only `/var/task`, so a
  // `cwd/temp` default cannot be created there. Fall back to the OS temp dir
  // instead, which is writable and writable-only-per-invocation on Vercel.
  if (process.env.VERCEL) {
    return tmpdir();
  }
  return join(process.cwd(), "temp");
}

/**
 * Default static prompt used to turn the converted DWG PNG into a realistic
 * "beautification" visualization of the drawn design.
 *
 * The prompt is owner-supplied and kept verbatim: it is the specification of
 * what the generated image must be, so it is edited as prose, not generated.
 * Its `Text and Drawing Annotation Rule` and the sheet's extracted text are
 * complementary — the rule requires the model to *read* the drawing's room and
 * material names but forbids reproducing them, and `drawingNotes` supplies those
 * strings as text because they are only a few pixels tall in the raster.
 *
 * Overridable via the GEMINI_PROMPT environment variable, which wins over this
 * default when set.
 */
export const DEFAULT_GEMINI_PROMPT = `Generic Drawing-to-Realistic-Image Prompt
Analyze the uploaded architectural drawing/elevation carefully and automatically identify the space, room type, architectural elements, layout, materials, dimensions, openings, furniture positions, fixtures, wall treatments, flooring, ceiling details, and overall design intent visible in the drawing.Generate a highly realistic, photorealistic visualization of the same design shown in the uploaded drawing.
Strict requirements:

Preserve the original architectural design exactly as shown.
Do not change, redesign, remove, add, or relocate any architectural element.
Maintain the same proportions, geometry, openings, walls, columns, doors, windows, niches, furniture positions, fixtures, patterns, and design details.
Interpret the drawing intelligently and infer the appropriate real-world environment from the visual information itself.
If the drawing represents an interior, generate the corresponding realistic interior.
If it represents an exterior elevation, generate the corresponding realistic exterior/elevation.
If it represents a bathroom, bedroom, living area, kitchen, showroom, commercial space, façade, or any other space, automatically recognize it and visualize it accordingly.
Do not require a manual description of what the drawing represents.
Use realistic materials, textures, lighting, reflections, shadows, depth, and perspective appropriate to the identified space.
Maintain all visible design details from the source drawing.
Convert the 2D architectural representation into a convincing real-world photographic visualization while keeping the design unchanged.
Use premium architectural visualization quality with realistic proportions and physically believable lighting.
The final image should look like a professionally photographed completed project based directly on the uploaded drawing.
Text and Drawing Annotation Rule:

Do not include any text, labels, dimensions, measurements, numbers, annotations, arrows, technical notes, room names, material names, or other written information from the uploaded drawing in the generated image.
Use the information in the drawing to understand the design, but do not reproduce the written information visually.
The final generated image must contain no visible CAD/drawing text or technical annotations.
Keep the actual architectural elements represented by the text or annotations unchanged.
Most important: The uploaded drawing is the source of truth. Prioritize its geometry, layout, proportions, and design over assumptions. Only add realistic rendering qualities needed to visualize the design in the real world.
Do not reinterpret the design. Do not introduce a new design. Do not make creative architectural changes.
Output a high-resolution, photorealistic final visualization of the uploaded drawing, with the architectural design preserved exactly and without any visible text or technical annotations.
ABSOLUTE REQUIREMENT: The final generated image must be completely text-free. No letters, words, numbers, labels, dimensions, annotations, symbols, or written markings of any kind should appear anywhere in the image.
`;

/**
 * Configuration is read from the environment on every call so that tests can
 * override values (e.g. a throwaway TEMP_DIR) without import-order tricks.
 */
export function getConfig(): AppConfig {
  const tempRootDir = resolveTempRoot();
  const outputsDir = join(tempRootDir, "outputs");
  return {
    maxFileSizeBytes: parsePositiveInt(process.env.MAX_FILE_SIZE_MB, 80) * 1024 * 1024,
    conversionBudgetMs: parsePositiveInt(process.env.CONVERSION_BUDGET_MS, 260_000),
    // 4500px rather than 3000px: at 3000px a 2.5mm annotation on a large sheet
    // lands around 6px of cap height, which is unreadable both for a human
    // checking the conversion and for the image model reading the sheet.
    maxPngDimension: parsePositiveInt(process.env.MAX_PNG_DIMENSION, 4500),
    // Defaults to the layout size, so a deployment only pays for the extra
    // resolution if it explicitly asks for it.
    modelPngDimension: parsePositiveInt(
      process.env.MODEL_PNG_DIMENSION,
      parsePositiveInt(process.env.MAX_PNG_DIMENSION, 4500)
    ),
    marginPx: parsePositiveInt(process.env.MARGIN_PX, 50),
    // Labels are drawn at max(true size, this floor). On a large site plan the
    // median annotation is millimetres tall and scales to a fraction of a pixel,
    // so without a floor the text is present in the SVG but invisible in the PNG.
    minTextCapPx: parsePositiveInt(process.env.MIN_TEXT_CAP_PX, DEFAULT_MIN_TEXT_CAP_PX),
    maxTextCapPx: parsePositiveInt(process.env.MAX_TEXT_CAP_PX, DEFAULT_MAX_TEXT_CAP_PX),
    strictTextScale: (process.env.STRICT_TEXT_SCALE ?? "true").trim().toLowerCase() !== "false",
    pngSupersample: parsePositiveInt(process.env.PNG_SUPERSAMPLE, 2),
    minStrokePx: parsePositiveFloat(process.env.MIN_STROKE_PX, 1),
    maxLayouts: parsePositiveInt(process.env.MAX_LAYOUTS, 100),
    dropBlankSheets: (process.env.DROP_BLANK_SHEETS ?? "").trim().toLowerCase() === "true",
    blankSheetInkFraction: parsePositiveFloat(process.env.BLANK_SHEET_INK_FRACTION, 0.005),
    modelClusterGapFraction: parsePositiveFloat(process.env.MODEL_CLUSTER_GAP_FRACTION, 0.03),
    modelClusterMaxDepth: parsePositiveInt(process.env.MODEL_CLUSTER_MAX_DEPTH, 12),
    cleanupAgeMs: parsePositiveInt(process.env.CLEANUP_AGE_MINUTES, 30 * 24 * 60) * 60 * 1000,
    uploadAgeMs: parsePositiveInt(process.env.UPLOAD_AGE_MINUTES, 60) * 60 * 1000,
    tempRootDir,
    outputsDir,
    cacheAgeMs: parsePositiveInt(process.env.CACHE_AGE_MINUTES, 30 * 24 * 60) * 60 * 1000,
    rateLimitMax: parsePositiveInt(process.env.RATE_LIMIT_PER_MINUTE, 30),
    geminiApiKey: (process.env.GEMINI_API_KEY ?? "").trim(),
    geminiPrompt: (process.env.GEMINI_PROMPT ?? DEFAULT_GEMINI_PROMPT).trim(),
    geminiModel: (process.env.GEMINI_MODEL ?? "gemini-3.1-flash-image").trim(),
    // 3 generations per conversion by default. Reuse within the 30-day AI pair
    // cache does not consume a generation. 0 = unlimited.
    aiGenerationLimit: parseNonNegativeInt(process.env.AI_GENERATION_LIMIT, 3),
    geminiTimeoutMs: parsePositiveInt(process.env.GEMINI_TIMEOUT_MS, 240_000),
    tilesviewApiUrl: (process.env.TILESVIEW_API_URL ?? "https://tilesview.ai/Provider/app/api-room-planner-data").trim(),
    tilesviewAppKey: (process.env.TILESVIEW_APP_KEY ?? "").trim(),
    tilesviewAppSecret: (process.env.TILESVIEW_APP_SECRET ?? "").trim(),
    tilesviewAppKeyHeader: (process.env.TILESVIEW_APP_KEY_HEADER ?? "app_key").trim(),
    tilesviewAppSecretHeader: (process.env.TILESVIEW_APP_SECRET_HEADER ?? "app_secret").trim(),
    tilesviewVisualizerBaseUrl: (
      process.env.TILESVIEW_VISUALIZER_BASE_URL ?? "https://tilesview.ai/app/EZEnoscu4lODABbT_sHm7Q/visualizer"
    ).trim().replace(/\/+$/, ""),
  };
}

/**
 * Ensures the output temp directory exists.
 *
 * Best-effort by design: on Vercel the bundle directory is read-only, and the
 * Supabase-backed store does not need local files at all, so an unwritable temp
 * root must not take the whole conversion down with an opaque 500.
 */
export function ensureTempDirs(config: AppConfig): void {
  try {
    mkdirSync(config.outputsDir, { recursive: true });
  } catch (err) {
    console.warn(
      `[config] could not create ${config.outputsDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
