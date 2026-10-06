import { randomUUID } from "node:crypto";
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
const CONVERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newConversionId(): string {
  return randomUUID();
}

/** Strict validation of a conversion ID; guards every download/delete path. */
export function isSafeConversionId(id: string): boolean {
  return CONVERSION_ID_PATTERN.test(id);
}

export function outputPath(dir: string, id: string): string {
  return join(dir, `${id}.png`);
}

/** AI-generated PNG output for a given conversion (Gemini path). */
export function aiOutputPath(dir: string, id: string): string {
  return join(dir, `${id}.ai.png`);
}

/**
 * Write a file atomically: the content is first written to a unique sibling
 * file and then renamed over the destination, so a reader can never observe a
 * partially written file (e.g. a download arriving mid-write).
 */
export function writeBufferFileAtomic(absolutePath: string, buffer: Uint8Array): void {
  const tmpPath = `${absolutePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, absolutePath);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
