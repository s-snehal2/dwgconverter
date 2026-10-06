import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Automatic cleanup of temporary files. Directories are swept recursively for
 * files whose modification time is older than the configured age, so anything
 * nested one level down is reclaimed rather than leaked. Emptied subdirectories
 * are pruned. Best-effort: failures deleting a single file never break the
 * request.
 */
export function sweepDirectory(dir: string, olderThanMs: number): number {
  const now = Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stats = statSync(full);
      if (stats.isDirectory()) {
        removed += sweepDirectory(full, olderThanMs);
        try {
          if (readdirSync(full).length === 0) {
            rmSync(full, { recursive: true, force: true });
          }
        } catch {
          // Leave the directory in place.
        }
      } else if (stats.isFile() && now - stats.mtimeMs > olderThanMs) {
        rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      // Skip files that vanished or can't be inspected.
    }
  }
  return removed;
}

export function sweepTempDirs(dirs: string[], olderThanMs: number): number {
  let removed = 0;
  for (const dir of dirs) {
    removed += sweepDirectory(dir, olderThanMs);
  }
  return removed;
}