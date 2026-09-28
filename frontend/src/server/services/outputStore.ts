import { put, get, list, del } from "@vercel/blob";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
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
  await put(pathname, body, {
    access: "private",
    contentType,
    cacheControlMaxAge: 60,
    // Re-generating an AI image for the same conversion reuses the same path,
    // so overwriting must be allowed (the default throws "blob already exists").
    allowOverwrite: true,
  });
}

async function readBlob(pathname: string): Promise<Buffer | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) {
    return null;
  }
  return Buffer.from(await new Response(result.stream).arrayBuffer());
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
  if (isBlobEnabled()) {
    await putBlob(outputBlobPath(id), Buffer.from(png), "image/png");
    await putBlob(outputNameBlobPath(id), fileName, "text/plain");
    return;
  }
  const config = getConfig();
  ensureTempDirs(config);
  const abs = outputPath(config.outputsDir, id);
  writeBufferFileAtomic(abs, png);
  writeFileSync(`${abs}.name`, fileName, "utf8");
}

/** Persist an AI-generated PNG plus its display filename. */
export async function saveAiOutput(id: string, png: Uint8Array, fileName: string): Promise<void> {
  if (isBlobEnabled()) {
    await putBlob(aiBlobPath(id), Buffer.from(png), "image/png");
    await putBlob(aiNameBlobPath(id), fileName, "text/plain");
    return;
  }
  const config = getConfig();
  ensureTempDirs(config);
  const abs = aiOutputPath(config.outputsDir, id);
  writeBufferFileAtomic(abs, png);
  writeFileSync(`${abs}.name`, fileName, "utf8");
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
  if (!existsSync(abs)) {
    return null;
  }
  return { buffer: readFileSync(abs), fileName: readSidecarName(`${abs}.name`, "dwg-conversion.png") };
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
  if (!existsSync(abs)) {
    return null;
  }
  return { buffer: readFileSync(abs), fileName: readSidecarName(`${abs}.name`, "dwg-ai-generation.png") };
}

function readSidecarName(path: string, fallback: string): string {
  try {
    if (existsSync(path)) {
      const stored = readFileSync(path, "utf8");
      if (stored) {
        return stored;
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
  try {
    if (!existsSync(abs)) {
      return 0;
    }
    return parseCount(readFileSync(abs, "utf8"));
  } catch {
    return 0;
  }
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
  writeFileSync(`${aiOutputPath(config.outputsDir, id)}.count`, String(next), "utf8");
  return next;
}

function parseCount(stored: string | null): number {
  const parsed = Number.parseInt(stored ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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