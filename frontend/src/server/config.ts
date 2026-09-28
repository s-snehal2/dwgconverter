import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
  marginPx: number;
  /** Oversample factor for anti-aliasing (2 = render at 2x, downscale to fit). */
  pngSupersample: number;
  /** Minimum stroke thickness in pixels, so thin CAD lines stay visible. */
  minStrokePx: number;
  /** Maximum number of paper-space layout sheets converted per DWG. */
  maxLayouts: number;
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
  /** Maximum length of a user-supplied AI image prompt, in characters. */
  maxAiPromptChars: number;
  cleanupAgeMs: number;
  tempRootDir: string;
  uploadsDir: string;
  outputsDir: string;
  rateLimitMax: number;
  /** Gemini API key for AI image generation (empty = AI features disabled). */
  geminiApiKey: string;
  /** User-visible static prompt sent to Gemini alongside the DWG PNG. */
  geminiPrompt: string;
  /** Gemini image-generation model id (Nano Banana 2). */
  geminiModel: string;
  /** Max successful AI image generations allowed per converted drawing. */
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
 * visualization. Overridable via the GEMINI_PROMPT environment variable.
 */
export const DEFAULT_GEMINI_PROMPT = `Generic Drawing-to-Realistic-Image Prompt
Analyze the uploaded architectural drawing/elevation carefully and automatically identify the space, room type, architectural elements, layout, materials, dimensions, openings, furniture positions, fixtures, wall treatments, flooring, ceiling details, and overall design intent visible in the drawing.Generate a highly realistic, photorealistic visualization of the same design shown in the uploaded drawing.
Strict requirements:

Multiple Drawings / Views Rule:

If the uploaded drawing contains more than one drawing, elevation, or view (for example four elevations showing the four sides of one room), treat all of them as different views of the SAME single space and of one unified design.
Merge the information from every view into a single coherent space: keep walls, openings, doors, windows, niches, fixtures, furniture positions, materials, and proportions consistent across all sides.
Output exactly ONE unified photorealistic image of that one space.
CRITICAL: Do not reproduce the input composition. Do NOT output a collage, grid, mosaic, storyboard, or multiple separate panels. Do not keep the drawings' arrangement. The final image must be a single continuous scene of one room/design.
Preserve the original architectural design exactly as shown, considering all views together.
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
ABSOLUTE REQUIREMENT: The final generated image must be completely text-free. No letters, words, numbers, labels, dimensions, annotations, symbols, or written markings of any kind should appear anywhere in the image`;

/**
 * Configuration is read from the environment on every call so that tests can
 * override values (e.g. a throwaway TEMP_DIR) without import-order tricks.
 */
export function getConfig(): AppConfig {
  const tempRootDir = resolveTempRoot();
  const uploadsDir = join(tempRootDir, "uploads");
  const outputsDir = join(tempRootDir, "outputs");
  return {
    maxFileSizeBytes: parsePositiveInt(process.env.MAX_FILE_SIZE_MB, 80) * 1024 * 1024,
    conversionBudgetMs: parsePositiveInt(process.env.CONVERSION_BUDGET_MS, 260_000),
    maxPngDimension: parsePositiveInt(process.env.MAX_PNG_DIMENSION, 3000),
    marginPx: parsePositiveInt(process.env.MARGIN_PX, 50),
    pngSupersample: parsePositiveInt(process.env.PNG_SUPERSAMPLE, 2),
    minStrokePx: parsePositiveFloat(process.env.MIN_STROKE_PX, 1),
    maxLayouts: parsePositiveInt(process.env.MAX_LAYOUTS, 100),
    blankSheetInkFraction: parsePositiveFloat(process.env.BLANK_SHEET_INK_FRACTION, 0.005),
    modelClusterGapFraction: parsePositiveFloat(process.env.MODEL_CLUSTER_GAP_FRACTION, 0.03),
    modelClusterMaxDepth: parsePositiveInt(process.env.MODEL_CLUSTER_MAX_DEPTH, 12),
    maxAiPromptChars: parsePositiveInt(process.env.MAX_AI_PROMPT_CHARS, 1000),
    cleanupAgeMs: parsePositiveInt(process.env.CLEANUP_AGE_MINUTES, 1440) * 60 * 1000,
    tempRootDir,
    uploadsDir,
    outputsDir,
    rateLimitMax: parsePositiveInt(process.env.RATE_LIMIT_PER_MINUTE, 30),
    geminiApiKey: (process.env.GEMINI_API_KEY ?? "").trim(),
    geminiPrompt: (process.env.GEMINI_PROMPT ?? DEFAULT_GEMINI_PROMPT).trim(),
    geminiModel: (process.env.GEMINI_MODEL ?? "gemini-3.1-flash-image").trim(),
    aiGenerationLimit: parsePositiveInt(process.env.AI_GENERATION_LIMIT, 5),
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
 * Ensures the upload/output temp directories exist.
 *
 * Best-effort by design: on Vercel the bundle directory is read-only, and the
 * Blob-backed store does not need local files at all, so an unwritable temp
 * root must not take the whole conversion down with an opaque 500.
 */
export function ensureTempDirs(config: AppConfig): void {
  for (const dir of [config.uploadsDir, config.outputsDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(
        `[config] could not create ${dir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
