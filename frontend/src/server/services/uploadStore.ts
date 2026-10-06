import { AppError } from "@/server/utils/errors";
import { getObject, isSupabaseEnabled, removeObjects } from "@/server/services/supabaseStore";

/**
 * Staged inbound DWGs.
 *
 * `/api/convert` accepts an optional `uploadPath` alongside the multipart body,
 * and this is the only way to read such a staged DWG back. The browser no longer
 * uploads directly (that route is gone), so nothing here mints signed URLs any
 * more — an `uploadPath` can only refer to a key an earlier version of this app
 * wrote, or one written out of band.
 *
 * Everything that comes back is a bucket-relative *path* checked against a
 * strict pattern below, so the secret key cannot be steered at a host of the
 * caller's choosing.
 */

const UPLOAD_KEY_RE = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dwg$/i;

/** True when `path` is a `uploads/{uuid}.dwg` key we could have issued. */
export function isTrustedUploadPath(path: string): boolean {
  return UPLOAD_KEY_RE.test(path);
}

/** Read an uploaded DWG back out of storage. Throws if it is missing or unreadable. */
export async function readUpload(uploadPath: string): Promise<Buffer> {
  if (!isSupabaseEnabled()) {
    throw new AppError("STORAGE_UNAVAILABLE", "Storage is not enabled.");
  }
  if (!isTrustedUploadPath(uploadPath)) {
    throw new AppError("INVALID_FILE", "Upload path is not trusted.");
  }

  const buffer = await getObject(uploadPath);
  if (!buffer) {
    throw new AppError("INVALID_FILE", "Upload not found.");
  }
  return buffer;
}

/**
 * Remove an upload once it has been consumed.
 *
 * Best-effort: a failed delete must not fail the conversion, and the periodic
 * sweep in `outputStore` picks up anything left behind.
 */
export async function deleteUpload(uploadPath: string): Promise<void> {
  if (!isSupabaseEnabled() || !isTrustedUploadPath(uploadPath)) {
    return;
  }

  try {
    await removeObjects([uploadPath]);
  } catch {
    // Left for the sweep.
  }
}