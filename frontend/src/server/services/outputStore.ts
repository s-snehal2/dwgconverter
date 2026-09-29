import { put, get, list, del } from "@vercel/blob";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@/server/utils/errors";
import { getConfig, ensureTempDirs } from "@/server/config";
import { sweepTempDirs } from "@/server/services/fileCleanup";
import { outputPath, aiOutputPath, writeBufferFileAtomic } from "@/server/utils/storage";

/**
 * Output persistence facade.
 *
 * On Vercel (when `BLOB_READ_WRITE_TOKEN` is present) converted PNGs, AI
 * images and their display names live in Vercel Blob so they survive the
 * convert→preview two-request flow on ephemeral serverless filesystems.
 *
 * Everywhere else (local dev, tests) the original on-disk layout is used —
 * `outputs/{id}.png` + a `{id}.png.name` sidecar — so nothing changes outside
 * Vercel.
 */

export function isBlobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN);
}

/** Display names are clamped so they can never break Content-Disposition. */
const MAX_SHARED_NAME_LENGTH = 180;

function clampFileName(name: string): string {
  return name.length > MAX_SHARED_NAME_LENGTH
    ? name.slice(0, MAX_SHARED_NAME_LENGTH)
    : name;
}

const BLOB_PREFIX = "outputs/";

/**
 * Prefix for in-flight DWG uploads. Kept here rather than beside its only
 * consumer so this module never has to import `uploadStore` (which imports
 * back for `isBlobEnabled`).
 */
export const UPLOAD_BLOB_PREFIX = "uploads/";

function outputBlobPath(id: string): string {
  return `${BLOB_PREFIX}${id}.png`;
}

function outputNameBlobPath(id: string): string {
  return `${outputBlobPath(id)}.name`;
}

function aiBlobPath(id: string): string {
  return `${BLOB_PREFIX}${id}.ai.png`;
}

function aiNameBlobPath(id: string): string {
  return `${aiBlobPath(id)}.name`;
}

function aiCountBlobPath(id: string): string {
  return `${aiBlobPath(id)}.count`;
}

async function putBlob(pathname: string, body: string | Buffer, contentType: string): Promise<void> {
  try {
    await put(pathname, body, {
      access: "private",
      contentType,
      cacheControlMaxAge: 60,
      // Re-generating an AI image for the same conversion reuses the same path,
      // so overwriting must be allowed (the default throws "blob already exists").
      allowOverwrite: true,
    });
  } catch (err) {
    throw storageAppError(err);
  }
}

/** Consume a web stream once into a single Buffer (one full-size allocation). */
async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readBlob(pathname: string): Promise<Buffer | null> {
  try {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }
    return await streamToBuffer(result.stream);
  } catch (err) {
    throw storageAppError(err);
  }
}

/** Wrap storage failures as retryable errors, never as a generic 500. */
function storageAppError(err: unknown): AppError {
  return new AppError(
    "STORAGE_UNAVAILABLE",
    err instanceof Error ? err.message : String(err)
  );
}

async function readBlobText(pathname: string): Promise<string | null> {
  const bytes = await readBlob(pathname);
  return bytes ? bytes.toString("utf8") : null;
}

export interface StoredOutput {
  buffer: Buffer;
  fileName: string;
}

/** Persist a converted PNG plus its display filename. */
export async function saveOutput(id: string, png: Uint8Array, fileName: string): Promise<void> {
  const safeName = clampFileName(fileName);
  if (isBlobEnabled()) {
    await putBlob(outputBlobPath(id), Buffer.from(png), "image/png");
    await putBlob(outputNameBlobPath(id), safeName, "text/plain");
    return;
  }
  const config = getConfig();
  ensureTempDirs(config);
  const abs = outputPath(config.outputsDir, id);
  writeBufferFileAtomic(abs, png);
  writeBufferFileAtomic(`${abs}.name`, Buffer.from(safeName, "utf8"));
}

/** Persist an AI-generated PNG plus its display filename. */
export async function saveAiOutput(id: string, png: Uint8Array, fileName: string): Promise<void> {
  const safeName = clampFileName(fileName);
  if (isBlobEnabled()) {
    await putBlob(aiBlobPath(id), Buffer.from(png), "image/png");
    await putBlob(aiNameBlobPath(id), safeName, "text/plain");
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
  if (isBlobEnabled()) {
    const buffer = await readBlob(outputBlobPath(id));
    if (!buffer) {
      return null;
    }
    const storedName = await readBlobText(outputNameBlobPath(id));
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
  if (isBlobEnabled()) {
    const buffer = await readBlob(aiBlobPath(id));
    if (!buffer) {
      return null;
    }
    const storedName = await readBlobText(aiNameBlobPath(id));
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
  try {
    const stored = readIfExists(path);
    if (stored) {
      const text = stored.toString("utf8");
      if (text) {
        return text;
      }
    }
  } catch {
    // Fall back to the generic name.
  }
  return fallback;
}

/** Number of AI images successfully generated for a conversion (0 when none). */
export async function getAiGenerationCount(id: string): Promise<number> {
  if (isBlobEnabled()) {
    const stored = await readBlobText(aiCountBlobPath(id));
    return parseCount(stored);
  }
  const abs = `${aiOutputPath(getConfig().outputsDir, id)}.count`;
  const stored = readIfExists(abs);
  return parseCount(stored ? stored.toString("utf8") : null);
}

/** Records one successful AI generation and returns the new total. */
export async function incrementAiGenerationCount(id: string): Promise<number> {
  const next = (await getAiGenerationCount(id)) + 1;
  if (isBlobEnabled()) {
    await putBlob(aiCountBlobPath(id), String(next), "text/plain");
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

function parseCount(stored: string | null): number {
  const parsed = Number.parseInt(stored ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

const CACHE_PREFIX = "cache/";

export interface CachedAiImage {
  buffer: Buffer;
  fileName: string;
}

function cacheAiImagePath(hash: string): string {
  return `${CACHE_PREFIX}${hash}.ai.png`;
}

function cacheMetaPath(hash: string): string {
  return `${CACHE_PREFIX}${hash}.meta`;
}

function cacheMetaString(fileName: string): string {
  return JSON.stringify({ fileName, createdAt: Date.now() });
}

function parseCacheMeta(stored: string | null): Pick<CachedAiImage, "fileName"> | null {
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as { fileName?: unknown };
    return typeof parsed.fileName === "string" && parsed.fileName
      ? { fileName: parsed.fileName }
      : null;
  } catch {
    return null;
  }
}

/**
 * Persist an AI image in the long-lived cache, keyed by the sha256 of the
 * converted PNG. Stored under a dedicated `cache/` namespace so the
 * short-lived output sweep (CLEANUP_AGE_MINUTES) never touches it.
 */
export async function saveCacheAiImage(hash: string, png: Uint8Array, fileName: string): Promise<void> {
  const safeName = clampFileName(fileName);
  if (isBlobEnabled()) {
    await putBlob(cacheAiImagePath(hash), Buffer.from(png), "image/png");
    await putBlob(cacheMetaPath(hash), cacheMetaString(safeName), "application/json");
    return;
  }
  const config = getConfig();
  ensureTempDirs(config);
  writeBufferFileAtomic(join(config.cacheDir, `${hash}.ai.png`), png);
  writeBufferFileAtomic(
    join(config.cacheDir, `${hash}.meta`),
    Buffer.from(cacheMetaString(safeName), "utf8")
  );
}

/** Read a cached AI image. Returns null when there is no cached result yet. */
export async function readCacheAiImage(hash: string): Promise<CachedAiImage | null> {
  if (isBlobEnabled()) {
    const buffer = await readBlob(cacheAiImagePath(hash));
    if (!buffer) {
      return null;
    }
    const meta = parseCacheMeta(await readBlobText(cacheMetaPath(hash)));
    return { buffer, fileName: meta?.fileName ?? "dwg-ai-generation.png" };
  }
  const config = getConfig();
  const abs = join(config.cacheDir, `${hash}.ai.png`);
  const buffer = readIfExists(abs);
  if (!buffer) {
    return null;
  }
  let fileName = "dwg-ai-generation.png";
  try {
    const meta = parseCacheMeta(readFileSync(join(config.cacheDir, `${hash}.meta`), "utf8"));
    if (meta) {
      fileName = meta.fileName;
    }
  } catch {
    // Fall back to the generic name.
  }
  return { buffer, fileName };
}

/**
 * Age-based sweep of the AI-image cache. Uses upload/mtime so the cached
 * images naturally age out after CACHE_AGE_MINUTES.
 */
export async function sweepExpiredCache(olderThanMs: number): Promise<number> {
  if (isBlobEnabled()) {
    const now = Date.now();
    const expired: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({
        prefix: CACHE_PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const blob of page.blobs) {
        if (now - blob.uploadedAt.getTime() > olderThanMs) {
          expired.push(blob.url);
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (expired.length > 0) {
      await del(expired);
    }
    return expired.length;
  }
  const config = getConfig();
  return sweepTempDirs([config.cacheDir], olderThanMs);
}

/** Age-based sweep of expired outputs (uploads + outputs). Best-effort. */
export async function sweepExpiredOutputs(olderThanMs: number): Promise<number> {
  if (isBlobEnabled()) {
    return sweepExpiredBlobs(olderThanMs);
  }
  const config = getConfig();
  return sweepTempDirs([config.uploadsDir, config.outputsDir], olderThanMs);
}

async function sweepExpiredBlobs(olderThanMs: number): Promise<number> {
  const now = Date.now();
  const expired: string[] = [];
  // Uploads live under their own prefix and are normally deleted as soon as a
  // conversion finishes, but a crashed or timed-out conversion can leave one
  // behind, so both prefixes are swept.
  for (const prefix of [BLOB_PREFIX, UPLOAD_BLOB_PREFIX]) {
    let cursor: string | undefined;
    do {
      const page = await list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const blob of page.blobs) {
        if (now - blob.uploadedAt.getTime() > olderThanMs) {
          expired.push(blob.url);
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  if (expired.length > 0) {
    await del(expired);
  }
  return expired.length;
}

/**
 * Throttle sweeps on the per-request hot path: the Blob sweep scans every
 * blob, so cap it at most once per 10 minutes per process. The daily cron
 * (which uses the unthrottled functions) still guarantees a full pass.
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

/** Throttled variant of sweepExpiredCache (≤ once per 10 minutes). */
export function sweepExpiredCacheThrottled(olderThanMs: number): Promise<number> {
  return throttledSweep("cache", () => sweepExpiredCache(olderThanMs));
}