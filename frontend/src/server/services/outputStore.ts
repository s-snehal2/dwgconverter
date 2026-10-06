import { readFileSync, rmSync } from "node:fs";
import { getConfig, ensureTempDirs } from "@/server/config";
import { sweepTempDirs } from "@/server/services/fileCleanup";
import {
  getObject,
  getObjectText,
  isSupabaseEnabled,
  listAges,
  putObject,
  removeObjects,
} from "@/server/services/supabaseStore";
import { outputPath, aiOutputPath, writeBufferFileAtomic } from "@/server/utils/storage";

/** Display names are clamped so they can never break Content-Disposition. */
const MAX_SHARED_NAME_LENGTH = 180;

function clampFileName(name: string): string {
  return name.length > MAX_SHARED_NAME_LENGTH
    ? name.slice(0, MAX_SHARED_NAME_LENGTH)
    : name;
}

const OUTPUT_PREFIX = "outputs/";

/**
 * Staging prefix for inbound DWGs. Duplicated from `uploadStore` on purpose so
 * neither store imports the other, but it must stay byte-identical to
 * `UPLOAD_KEY_RE` there or this sweep would never match a real upload.
 */
const UPLOAD_PREFIX = "uploads/";

function outputKey(id: string): string {
  return `${OUTPUT_PREFIX}${id}.png`;
}
function outputNameKey(id: string): string {
  return `${outputKey(id)}.name`;
}

function aiKey(id: string): string {
  return `${OUTPUT_PREFIX}${id}.ai.png`;
}

function aiNameKey(id: string): string {
  return `${aiKey(id)}.name`;
}

function aiCountKey(id: string): string {
  return `${aiKey(id)}.count`;
}

export interface StoredOutput {
  buffer: Buffer;
  fileName: string;
}

/**
 * The content identity of a converted sheet, written once at convert time.
 *
 * Persisting this next to the PNG is what lets `/api/generate` reach the sheet's
 * identity by id, instead of re-hashing a multi-megabyte PNG on every request.
 */
export interface OutputSourceMeta {
  /** sha256 of the uploaded DWG, filing the drawing history. */
  sourceHash: string;
  /** sha256 of this sheet's PNG, half of the AI pair identity. */
  pngHash: string;
  /**
   * Stable identity of this sheet inside its DWG, derived from `sourceHash` and
   * the layout's position rather than the per-upload conversion id, so a
   * re-upload resolves to the same AI pair.
   */
  sheetId?: string;
  /** The layout/view name, used as part of the AI pair identity. */
  viewName?: string;
}

function outputMetaKey(id: string): string {
  return `${outputKey(id)}.meta`;
}

function encodeSourceMeta(meta: OutputSourceMeta): string {
  return JSON.stringify(meta);
}

function decodeSourceMeta(stored: string | null): OutputSourceMeta | null {
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<OutputSourceMeta>;
    const hashPattern = /^[0-9a-f]{64}$/;
    if (
      typeof parsed.sourceHash === "string" &&
      hashPattern.test(parsed.sourceHash) &&
      typeof parsed.pngHash === "string" &&
      hashPattern.test(parsed.pngHash)
    ) {
      return {
        sourceHash: parsed.sourceHash,
        pngHash: parsed.pngHash,
        sheetId: typeof parsed.sheetId === "string" ? parsed.sheetId : undefined,
        viewName: typeof parsed.viewName === "string" ? parsed.viewName : undefined,
      };
    }
  } catch {
    // A malformed sidecar is treated as absent rather than failing the request.
  }
  return null;
}

/** Persist a converted PNG, its display filename, and its content identity. */
export async function saveOutput(
  id: string,
  png: Uint8Array,
  fileName: string,
  meta?: OutputSourceMeta
): Promise<void> {
  const safeName = clampFileName(fileName);
  if (isSupabaseEnabled()) {
    await putObject(outputKey(id), Buffer.from(png), "image/png");
    await putObject(outputNameKey(id), safeName, "text/plain");
    if (meta) {
      await putObject(outputMetaKey(id), encodeSourceMeta(meta), "application/json");
    }
    return;
  }
  const config = getConfig();
  ensureTempDirs(config);
  const abs = outputPath(config.outputsDir, id);
  writeBufferFileAtomic(abs, png);
  writeBufferFileAtomic(`${abs}.name`, Buffer.from(safeName, "utf8"));
  if (meta) {
    writeBufferFileAtomic(`${abs}.meta`, Buffer.from(encodeSourceMeta(meta), "utf8"));
  }
}

/** Read a conversion's content identity. Null for pre-existing conversions. */
export async function readOutputSourceMeta(id: string): Promise<OutputSourceMeta | null> {
  if (isSupabaseEnabled()) {
    return decodeSourceMeta(await getObjectText(outputMetaKey(id)));
  }
  return decodeSourceMeta(
    readSidecarText(`${outputPath(getConfig().outputsDir, id)}.meta`)
  );
}

/** Persist an AI-generated PNG plus its display filename. */
export async function saveAiOutput(id: string, png: Uint8Array, fileName: string): Promise<void> {
  const safeName = clampFileName(fileName);
  if (isSupabaseEnabled()) {
    await putObject(aiKey(id), Buffer.from(png), "image/png");
    await putObject(aiNameKey(id), safeName, "text/plain");
    return;
  }
  const config = getConfig();
  ensureTempDirs(config);
  const abs = aiOutputPath(config.outputsDir, id);
  writeBufferFileAtomic(abs, png);
  writeBufferFileAtomic(`${abs}.name`, Buffer.from(safeName, "utf8"));
}

/** Read a converted PNG. Returns null when it no longer exists. */
export async function readOutput(id: string): Promise<StoredOutput | null> {
  if (isSupabaseEnabled()) {
    const buffer = await getObject(outputKey(id));
    if (!buffer) {
      return null;
    }
    const storedName = await getObjectText(outputNameKey(id));
    return { buffer, fileName: storedName || "dwg-conversion.png" };
  }
  const abs = outputPath(getConfig().outputsDir, id);
  const buffer = readIfExists(abs);
  if (!buffer) {
    return null;
  }
  return { buffer, fileName: readSidecarName(`${abs}.name`, "dwg-conversion.png") };
}

/** Read an AI-generated PNG. Returns null when it no longer exists. */
export async function readAiOutput(id: string): Promise<StoredOutput | null> {
  if (isSupabaseEnabled()) {
    const buffer = await getObject(aiKey(id));
    if (!buffer) {
      return null;
    }
    const storedName = await getObjectText(aiNameKey(id));
    return { buffer, fileName: storedName || "dwg-ai-generation.png" };
  }
  const abs = aiOutputPath(getConfig().outputsDir, id);
  const buffer = readIfExists(abs);
  if (!buffer) {
    return null;
  }
  return { buffer, fileName: readSidecarName(`${abs}.name`, "dwg-ai-generation.png") };
}

/** Read a file, treating a missing file as `null` instead of throwing. */
function readIfExists(abs: string): Buffer | null {
  try {
    return readFileSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function readSidecarName(path: string, fallback: string): string {
  return readSidecarText(path) ?? fallback;
}

/** Read a small text sidecar from disk, treating any failure as absent. */
function readSidecarText(path: string): string | null {
  try {
    const stored = readIfExists(path);
    if (stored) {
      const text = stored.toString("utf8");
      if (text) {
        return text;
      }
    }
  } catch {
    // Fall back to the generic value.
  }
  return null;
}

/** Number of AI images successfully generated for a conversion (0 when none). */
export async function getAiGenerationCount(id: string): Promise<number> {
  if (isSupabaseEnabled()) {
    return parseCount(await getObjectText(aiCountKey(id)));
  }
  const abs = `${aiOutputPath(getConfig().outputsDir, id)}.count`;
  const stored = readIfExists(abs);
  return parseCount(stored ? stored.toString("utf8") : null);
}

/**
 * Records one successful AI generation and returns the new total.
 *
 * The read and the write are separated by the whole Gemini call in the caller,
 * so two requests for the same drawing can both read the same count and both
 * decide there is budget left — the cap on a paid API would be advisory.
 * Callers that need the limit to hold must go through `claimAiGeneration`.
 */
export async function incrementAiGenerationCount(id: string): Promise<number> {
  const next = (await getAiGenerationCount(id)) + 1;
  if (isSupabaseEnabled()) {
    await putObject(aiCountKey(id), String(next), "text/plain");
    return next;
  }
  const config = getConfig();
  ensureTempDirs(config);
  writeBufferFileAtomic(
    `${aiOutputPath(config.outputsDir, id)}.count`,
    Buffer.from(String(next), "utf8")
  );
  return next;
}

/**
 * Serialize the check-and-increment for one conversion id.
 *
 * The lock is per-process, which is what a single Node instance needs; on
 * serverless the same drawing can be handled by two instances at once, and a
 * distributed store would be required to close that window. Holding the lock
 * across the generation would serialize every request for a drawing, so the
 * budget is claimed before Gemini is called and the generation proceeds outside.
 */
const generationLocks = new Map<string, Promise<unknown>>();

function withGenerationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = generationLocks.get(id) ?? Promise.resolve();
  // Chain onto the previous holder, ignoring its outcome so one rejection
  // cannot stop the next caller from running.
  const result = previous.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  generationLocks.set(id, settled);
  // Drop the entry once nothing is queued behind it, so the map cannot grow
  // without bound as different drawings are converted.
  void settled.then(() => {
    if (generationLocks.get(id) === settled) {
      generationLocks.delete(id);
    }
  });
  return result;
}

export interface AiGenerationClaim {
  /** Generations consumed including this one. */
  generationsUsed: number;
  /** False when the drawing was already at the limit; nothing was consumed. */
  claimed: boolean;
}

/**
 * Atomically consume one unit of the drawing's AI budget, or report that the
 * limit is already reached. Callers must invoke this instead of
 * `getAiGenerationCount` followed by `incrementAiGenerationCount`.
 */
export function claimAiGeneration(id: string, limit: number): Promise<AiGenerationClaim> {
  return withGenerationLock(id, async () => {
    const used = await getAiGenerationCount(id);
    if (used >= limit) {
      return { generationsUsed: used, claimed: false };
    }
    return { generationsUsed: await incrementAiGenerationCount(id), claimed: true };
  });
}

/** Release a claimed-but-unused generation when the generation itself failed. */
export async function releaseAiGenerationClaim(id: string): Promise<void> {
  await withGenerationLock(id, async () => {
    const next = (await getAiGenerationCount(id)) - 1;
    if (next <= 0) {
      if (isSupabaseEnabled()) {
        await removeObjects([aiCountKey(id)]);
        return;
      }
      const config = getConfig();
      ensureTempDirs(config);
      try {
        rmSync(`${aiOutputPath(config.outputsDir, id)}.count`, { force: true });
      } catch {
        // Best-effort.
      }
      return;
    }
    if (isSupabaseEnabled()) {
      await putObject(aiCountKey(id), String(next), "text/plain");
      return;
    }
    const config = getConfig();
    ensureTempDirs(config);
    writeBufferFileAtomic(
      `${aiOutputPath(config.outputsDir, id)}.count`,
      Buffer.from(String(next), "utf8")
    );
  });
}

function parseCount(stored: string | null): number {
  const parsed = Number.parseInt(stored ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Drawing-level AI generation counter (keyed by sourceHash, survives re-uploads). */
const DRAWING_COUNT_PREFIX = "outputs/ai-count-";

function sanitizeForFs(sourceHash: string): string {
  return sourceHash.replace(/:/g, "_");
}

function drawingCountKey(sourceHash: string): string {
  const safeHash = sanitizeForFs(sourceHash);
  return `${DRAWING_COUNT_PREFIX}${safeHash}.count`;
}

const drawingGenerationLocks = new Map<string, Promise<unknown>>();

function withDrawingGenerationLock<T>(sourceHash: string, fn: () => Promise<T>): Promise<T> {
  const previous = drawingGenerationLocks.get(sourceHash) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  drawingGenerationLocks.set(sourceHash, settled);
  void settled.then(() => {
    if (drawingGenerationLocks.get(sourceHash) === settled) {
      drawingGenerationLocks.delete(sourceHash);
    }
  });
  return result;
}

export async function getAiGenerationCountForDrawing(sourceHash: string): Promise<number> {
  if (isSupabaseEnabled()) {
    return parseCount(await getObjectText(drawingCountKey(sourceHash)));
  }
  const config = getConfig();
  const safeHash = sanitizeForFs(sourceHash);
  const abs = `${config.outputsDir}/ai-count-${safeHash}.count`;
  const stored = readIfExists(abs);
  return parseCount(stored ? stored.toString("utf8") : null);
}

async function incrementAiGenerationCountForDrawing(sourceHash: string): Promise<number> {
  const next = (await getAiGenerationCountForDrawing(sourceHash)) + 1;
  if (isSupabaseEnabled()) {
    await putObject(drawingCountKey(sourceHash), String(next), "text/plain");
    return next;
  }
  const config = getConfig();
  ensureTempDirs(config);
  writeBufferFileAtomic(
    `${config.outputsDir}/ai-count-${sourceHash}.count`,
    Buffer.from(String(next), "utf8")
  );
  return next;
}

export async function claimAiGenerationForDrawing(sourceHash: string, limit: number): Promise<AiGenerationClaim> {
  return withDrawingGenerationLock(sourceHash, async () => {
    const used = await getAiGenerationCountForDrawing(sourceHash);
    if (used >= limit) {
      return { generationsUsed: used, claimed: false };
    }
    return { generationsUsed: await incrementAiGenerationCountForDrawing(sourceHash), claimed: true };
  });
}

export async function releaseAiGenerationClaimForDrawing(sourceHash: string): Promise<void> {
  await withDrawingGenerationLock(sourceHash, async () => {
    const next = (await getAiGenerationCountForDrawing(sourceHash)) - 1;
    if (next <= 0) {
      if (isSupabaseEnabled()) {
        await removeObjects([drawingCountKey(sourceHash)]);
        return;
      }
      const config = getConfig();
      ensureTempDirs(config);
      try {
        rmSync(`${config.outputsDir}/ai-count-${sourceHash}.count`, { force: true });
      } catch {
        // Best-effort.
      }
      return;
    }
    if (isSupabaseEnabled()) {
      await putObject(drawingCountKey(sourceHash), String(next), "text/plain");
      return;
    }
    const config = getConfig();
    ensureTempDirs(config);
    writeBufferFileAtomic(
      `${config.outputsDir}/ai-count-${sourceHash}.count`,
      Buffer.from(String(next), "utf8")
    );
  });
}

/**
 * Delete everything under a prefix that is older than the cutoff.
 *
 * Keys are collected in a read-only pass before anything is removed: Supabase
 * pages `list` by offset, so deleting mid-scan would shift the window and skip
 * live objects.
 */
async function sweepPrefix(prefix: string, olderThanMs: number): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const stored = await listAges(prefix);
  const expired = stored.filter((entry) => entry.createdAtMs < cutoff).map((entry) => entry.key);
  return removeObjects(expired);
}

/**
 * Age-based sweep of expired objects. Best-effort.
 *
 * `outputs/` and `uploads/` are swept together but on separate clocks: a
 * converted PNG stays downloadable for the full retention window, whereas an
 * upload is worthless the moment its conversion finishes. Normally uploads are
 * deleted inline, so that pass only ever reclaims the debris of a crashed or
 * timed-out conversion.
 */
export async function sweepExpiredOutputs(
  olderThanMs: number,
  uploadOlderThanMs?: number
): Promise<number> {
  if (isSupabaseEnabled()) {
    const removedOutputs = await sweepPrefix(OUTPUT_PREFIX, olderThanMs);
    const removedUploads = await sweepPrefix(
      UPLOAD_PREFIX,
      uploadOlderThanMs ?? getConfig().uploadAgeMs
    );
    return removedOutputs + removedUploads;
  }
  const config = getConfig();
  return sweepTempDirs([config.outputsDir], olderThanMs);
}

/**
 * Throttle sweeps on the per-request hot path: a Supabase sweep lists every
 * object in the prefix, so cap it at most once per 10 minutes per process. The
 * daily cron (which uses the unthrottled functions) still guarantees a full
 * pass.
 */
const SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000;
const lastSweepByKind: Record<string, number> = {};

async function throttledSweep(kind: string, fn: () => Promise<number>): Promise<number> {
  const now = Date.now();
  if (now - (lastSweepByKind[kind] ?? 0) < SWEEP_MIN_INTERVAL_MS) {
    return 0;
  }
  try {
    return await fn();
  } finally {
    // Stamp on success *and* failure so a down store does not re-scan on every
    // request; a failure just waits for the next window (or the cron).
    lastSweepByKind[kind] = Date.now();
  }
}

/** Throttled variant of sweepExpiredOutputs (≤ once per 10 minutes). */
export function sweepExpiredOutputsThrottled(olderThanMs: number): Promise<number> {
  return throttledSweep("outputs", () => sweepExpiredOutputs(olderThanMs));
}

